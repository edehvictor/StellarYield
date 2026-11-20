import { describe, expect, it, vi } from "vitest";
import {
  I128_MAX,
  I128_MIN,
  assertDepositSimulationParams,
  assertSimulationAmount,
  ceilDiv,
  checkedAdd,
  checkedMul,
  floorDiv,
  previewDepositShares,
  previewWithdrawAssets,
  validateSimulationAmount,
} from "../src/simulationMath";
import { InvalidAmountError, InvalidSimulationParamsError } from "../src/errors";
import { ApiClient } from "../src/api/ApiClient";

describe("SDK boundary-safe simulation math (#1855)", () => {
  describe("checked arithmetic", () => {
    it("adds and multiplies within i128 bounds", () => {
      expect(checkedAdd(9007199254740993n, 7n)).toEqual({ ok: true, value: 9007199254741000n });
      expect(checkedMul(10000000n, 40000000n)).toEqual({ ok: true, value: 400000000000000n });
    });

    it("returns typed overflow failures at and beyond the i128 limits", () => {
      expect(checkedAdd(I128_MAX, 1n)).toEqual({
        ok: false,
        failure: { code: "OVERFLOW", message: "result exceeds the i128 range", field: "value" },
      });
      expect(checkedAdd(I128_MIN, -1n).ok).toBe(false);
      expect(checkedMul(I128_MAX, 2n).ok).toBe(false);
    });

    it("uses documented rounding and rejects non-positive divisors", () => {
      expect(ceilDiv(10n, 3n)).toEqual({ ok: true, value: 4n });
      expect(floorDiv(10n, 3n)).toEqual({ ok: true, value: 3n });
      expect(ceilDiv(0n, 3n)).toEqual({ ok: true, value: 0n });
      expect(ceilDiv(10n, 0n).ok).toBe(false);
      expect(floorDiv(10n, -1n).ok).toBe(false);
      expect(ceilDiv(-1n, 3n).ok).toBe(false);
    });
  });

  describe("deposit share preview", () => {
    it("handles zero, minimum and first-deposit boundaries", () => {
      expect(previewDepositShares({ amount: 0n, reserveBefore: 0n, sharesBefore: 0n })).toEqual({
        ok: true,
        value: 0n,
      });
      expect(previewDepositShares({ amount: 1n, reserveBefore: 0n, sharesBefore: 0n })).toEqual({
        ok: true,
        value: 1n,
      });
      expect(previewDepositShares({ amount: 1n, reserveBefore: 100n, sharesBefore: 100n })).toEqual({
        ok: true,
        value: 1n,
      });
    });

    it("rounds shares up for existing vaults", () => {
      expect(previewDepositShares({ amount: 10n, reserveBefore: 3n, sharesBefore: 3n })).toEqual({
        ok: true,
        value: 10n,
      });
      expect(previewDepositShares({ amount: 1n, reserveBefore: 3n, sharesBefore: 1n })).toEqual({
        ok: true,
        value: 1n,
      });
      expect(previewDepositShares({ amount: 9007199254740993n, reserveBefore: 7n, sharesBefore: 7n })).toEqual({
        ok: true,
        value: 9007199254740993n,
      });
    });

    it("returns typed failures near the maximum and for invalid reserves", () => {
      const nearLimit = previewDepositShares({
        amount: I128_MAX,
        reserveBefore: I128_MAX,
        sharesBefore: I128_MAX,
      });
      expect(nearLimit.ok).toBe(false);
      if (!nearLimit.ok) expect(nearLimit.failure.code).toBe("OVERFLOW");

      expect(previewDepositShares({ amount: 1n, reserveBefore: -1n, sharesBefore: 1n }).ok).toBe(false);
      expect(previewDepositShares({ amount: 1n, reserveBefore: 1n, sharesBefore: I128_MAX + 1n }).ok).toBe(false);
    });
  });

  describe("withdraw asset preview", () => {
    it("rounds assets down and handles the zero boundary", () => {
      expect(previewWithdrawAssets({ shares: 3n, reserve: 10n, sharesBefore: 4n })).toEqual({
        ok: true,
        value: 7n,
      });
      expect(previewWithdrawAssets({ shares: 0n, reserve: 10n, sharesBefore: 4n })).toEqual({
        ok: true,
        value: 0n,
      });
    });

    it("rejects empty vaults and over-redemption", () => {
      expect(previewWithdrawAssets({ shares: 1n, reserve: 0n, sharesBefore: 0n }).ok).toBe(false);
      expect(previewWithdrawAssets({ shares: 5n, reserve: 10n, sharesBefore: 4n }).ok).toBe(false);
    });
  });

  describe("request boundary validation", () => {
    it("accepts exact base units and safe integers", () => {
      expect(validateSimulationAmount("9007199254740993")).toEqual({
        ok: true,
        value: 9007199254740993n,
      });
      expect(assertSimulationAmount(Number.MAX_SAFE_INTEGER)).toBe(BigInt(Number.MAX_SAFE_INTEGER));
    });

    it("rejects unsafe, fractional, negative and out-of-range amounts", () => {
      for (const bad of [Number.MAX_SAFE_INTEGER + 1, 1.5, NaN, Infinity, -1, "1e21"]) {
        expect(validateSimulationAmount(bad).ok).toBe(false);
        expect(() => assertSimulationAmount(bad)).toThrow(InvalidAmountError);
      }
      expect(validateSimulationAmount((I128_MAX + 1n).toString()).ok).toBe(false);
    });

    it("validates simulation params before issuing a request and allows a safe retry", async () => {
      const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);
      const client = new ApiClient({ baseUrl: "https://api.test" });

      await expect(
        client.simulateDeposit({ strategyId: "blend", amount: Number.MAX_SAFE_INTEGER + 1, token: "USDC" }),
      ).rejects.toBeInstanceOf(InvalidAmountError);
      await expect(
        client.simulateDeposit({ strategyId: "", amount: 10, token: "USDC" }),
      ).rejects.toBeInstanceOf(InvalidSimulationParamsError);
      expect(fetchMock).not.toHaveBeenCalled();

      expect(() =>
        assertDepositSimulationParams({ strategyId: "blend", amount: 10, token: "USDC" }),
      ).not.toThrow();
      await expect(
        client.simulateDeposit({ strategyId: "blend", amount: 10, token: "USDC" }),
      ).resolves.toEqual({});
      expect(fetchMock).toHaveBeenCalledTimes(1);
      vi.unstubAllGlobals();
    });
  });
});
