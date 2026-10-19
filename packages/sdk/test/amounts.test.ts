import { describe, it, expect, vi } from "vitest";
import { Networks } from "@stellar/stellar-sdk";
import {
  VaultClient,
  InvalidAmountError,
  toTokenUnits,
  formatTokenUnits,
} from "../src";

const contractId = "CCW67TSB3SSSBDGRGBXMORAX6P4CBGQLGLKXMFFBVD7OH5VO5BTV6U2M";
const from = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7";

function stubbedVaultClient() {
  const client = new VaultClient({
    contractId,
    networkPassphrase: Networks.TESTNET,
    rpcUrl: "https://soroban-testnet.stellar.org",
  });
  const calls: Record<string, unknown>[] = [];
  const fake = vi.fn(async (args: Record<string, unknown>) => {
    calls.push(args);
    return { simulation: { latestLedger: 1 }, result: 0n };
  });
  for (const method of ["deposit", "withdraw", "harvest", "rebalance", "emergency_withdraw"]) {
    (client as any).generatedClient[method] = fake;
  }
  return { client, fake, calls };
}

describe("toTokenUnits", () => {
  it("passes bigint values through unchanged", () => {
    expect(toTokenUnits(123n)).toBe(123n);
    expect(toTokenUnits(2n ** 120n)).toBe(2n ** 120n);
  });

  it("accepts safe integer numbers", () => {
    expect(toTokenUnits(0)).toBe(0n);
    expect(toTokenUnits(1_000_000_000)).toBe(1_000_000_000n);
    expect(toTokenUnits(Number.MAX_SAFE_INTEGER)).toBe(BigInt(Number.MAX_SAFE_INTEGER));
  });

  it("rejects unsafe integers", () => {
    expect(() => toTokenUnits(Number.MAX_SAFE_INTEGER + 1)).toThrow(InvalidAmountError);
    expect(() => toTokenUnits(1e21)).toThrow(/MAX_SAFE_INTEGER/);
    expect(() => toTokenUnits(2 ** 64)).toThrow(InvalidAmountError);
  });

  it("rejects fractional, NaN, and infinite numbers", () => {
    expect(() => toTokenUnits(1.5)).toThrow(/fractional/);
    expect(() => toTokenUnits(0.1 + 0.2)).toThrow(InvalidAmountError);
    expect(() => toTokenUnits(Number.NaN)).toThrow(/finite/);
    expect(() => toTokenUnits(Number.POSITIVE_INFINITY)).toThrow(/finite/);
  });

  it("parses integer strings beyond the safe number range exactly", () => {
    expect(toTokenUnits("9007199254740993")).toBe(9007199254740993n);
    expect(toTokenUnits("170141183460469231731687303715884105727")).toBe(2n ** 127n - 1n);
  });

  it("scales decimal strings by token decimals without float rounding", () => {
    expect(toTokenUnits("1.5", { decimals: 7 })).toBe(15_000_000n);
    expect(toTokenUnits("0.1", { decimals: 7 })).toBe(1_000_000n);
    expect(toTokenUnits("0.0000001", { decimals: 7 })).toBe(1n);
    expect(toTokenUnits("100", { decimals: 7 })).toBe(1_000_000_000n);
    expect(toTokenUnits("922337203685.4775807", { decimals: 7 })).toBe(9223372036854775807n);
  });

  it("rejects fractional strings without decimals or with too many digits", () => {
    expect(() => toTokenUnits("1.5")).toThrow(/require `decimals`/);
    expect(() => toTokenUnits("0.00000001", { decimals: 7 })).toThrow(/8 fractional digits/);
  });

  it("rejects malformed strings", () => {
    for (const bad of ["", " 1", "1 ", "1e6", "0x10", "+1", "1.", ".5", "1,000", "abc", "Infinity"]) {
      expect(() => toTokenUnits(bad, { decimals: 7 }), bad).toThrow(InvalidAmountError);
    }
  });

  it("rejects negative amounts unless explicitly allowed", () => {
    expect(() => toTokenUnits(-1)).toThrow(/negative/);
    expect(() => toTokenUnits("-5")).toThrow(/negative/);
    expect(() => toTokenUnits(-1n)).toThrow(/negative/);
    expect(toTokenUnits("-1.5", { decimals: 2, allowNegative: true })).toBe(-150n);
  });

  it("rejects unsupported runtime types", () => {
    expect(() => toTokenUnits(null as any)).toThrow(/unsupported type/);
    expect(() => toTokenUnits({} as any)).toThrow(/unsupported type/);
  });

  it("names the offending field in the error", () => {
    try {
      toTokenUnits(1.25, { field: "min_shares_out" });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidAmountError);
      expect(err).toMatchObject({ field: "min_shares_out", value: 1.25, code: "invalid_amount" });
    }
  });
});

describe("formatTokenUnits", () => {
  it("round-trips with toTokenUnits", () => {
    for (const value of ["0", "1", "1.5", "0.0000001", "922337203685.4775807"]) {
      expect(formatTokenUnits(toTokenUnits(value, { decimals: 7 }), 7)).toBe(value);
    }
    expect(formatTokenUnits(-150n, 2)).toBe("-1.5");
    expect(formatTokenUnits(42n, 0)).toBe("42");
  });
});

describe("VaultClient amount normalization", () => {
  it("keeps bigint arguments unchanged", async () => {
    const { client, calls } = stubbedVaultClient();
    await client.deposit({ from, amount: 1_000_000_000n });
    expect(calls[0]).toEqual({ from, amount: 1_000_000_000n, min_shares_out: 0n });
  });

  it("converts safe numbers and strings to bigint base units", async () => {
    const { client, calls } = stubbedVaultClient();
    await client.deposit.prepare({ from, amount: 500, min_shares_out: "9007199254740993" });
    await client.withdraw({ to: from, shares: "42" });
    await client.harvest({ caller: from, min_amount_out: 7 });
    expect(calls[0]).toEqual({ from, amount: 500n, min_shares_out: 9007199254740993n });
    expect(calls[1]).toEqual({ to: from, shares: 42n });
    expect(calls[2]).toEqual({ caller: from, min_amount_out: 7n });
  });

  it("rejects unsafe and fractional numbers before building a transaction", async () => {
    const { client, fake } = stubbedVaultClient();
    await expect(client.deposit({ from, amount: 2 ** 60 })).rejects.toBeInstanceOf(InvalidAmountError);
    await expect(client.withdraw({ to: from, shares: 0.5 })).rejects.toMatchObject({ field: "shares" });
    await expect(
      client.rebalance({ caller: from, target: contractId, amount: 1e30 })
    ).rejects.toBeInstanceOf(InvalidAmountError);
    await expect(
      client.emergencyWithdraw.prepare({ to: from, shares: Number.NaN })
    ).rejects.toBeInstanceOf(InvalidAmountError);
    await expect(client.getFlashLoanFee(1.1)).rejects.toBeInstanceOf(InvalidAmountError);
    expect(fake).not.toHaveBeenCalled();
  });
});
