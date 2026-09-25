import { describe, it, expect } from "vitest";
import {
  resolveContractError,
  isKnownError,
  CONTRACT_ERROR_MAP,
  UNKNOWN_ERROR_DEFINITION,
} from "./contractErrors";

describe("isKnownError", () => {
  it("returns true for every code in CONTRACT_ERROR_MAP", () => {
    for (const code of Object.keys(CONTRACT_ERROR_MAP)) {
      expect(isKnownError(code), `expected ${code} to be known`).toBe(true);
    }
  });

  it("returns false for an unknown code", () => {
    expect(isKnownError("NOT_A_REAL_CODE")).toBe(false);
  });

  it("returns false for an empty string", () => {
    expect(isKnownError("")).toBe(false);
  });

  it("is case-sensitive", () => {
    expect(isKnownError("insufficient_balance")).toBe(false);
    expect(isKnownError("INSUFFICIENT_BALANCE")).toBe(true);
  });
});

describe("resolveContractError — known codes", () => {
  it("resolves INSUFFICIENT_BALANCE with actionable guidance", () => {
    const def = resolveContractError("INSUFFICIENT_BALANCE");
    expect(def.title).toBe("Insufficient Balance");
    expect(def.actionable).toBe(true);
    expect(def.description.length).toBeGreaterThan(0);
  });

  it("resolves SLIPPAGE_EXCEEDED with actionable guidance", () => {
    const def = resolveContractError("SLIPPAGE_EXCEEDED");
    expect(def.title).toBe("Slippage Exceeded");
    expect(def.actionable).toBe(true);
  });

  it("resolves VAULT_PAUSED as non-actionable", () => {
    const def = resolveContractError("VAULT_PAUSED");
    expect(def.title).toBe("Vault Paused");
    expect(def.actionable).toBe(false);
  });

  it("resolves MINIMUM_DEPOSIT_NOT_MET with actionable guidance", () => {
    const def = resolveContractError("MINIMUM_DEPOSIT_NOT_MET");
    expect(def.actionable).toBe(true);
  });

  it("resolves WITHDRAWAL_LOCKED as non-actionable", () => {
    const def = resolveContractError("WITHDRAWAL_LOCKED");
    expect(def.actionable).toBe(false);
  });

  it("resolves UNAUTHORIZED as non-actionable", () => {
    const def = resolveContractError("UNAUTHORIZED");
    expect(def.actionable).toBe(false);
  });

  it("resolves CONTRACT_OVERFLOW as non-actionable", () => {
    const def = resolveContractError("CONTRACT_OVERFLOW");
    expect(def.actionable).toBe(false);
  });

  it("resolves STALE_PRICE_FEED as non-actionable", () => {
    const def = resolveContractError("STALE_PRICE_FEED");
    expect(def.title).toBe("Stale Price Feed");
    expect(def.actionable).toBe(false);
  });

  it("resolves EPOCH_NOT_SETTLED as non-actionable", () => {
    const def = resolveContractError("EPOCH_NOT_SETTLED");
    expect(def.actionable).toBe(false);
  });

  it("resolves DUPLICATE_DEPOSIT with actionable guidance", () => {
    const def = resolveContractError("DUPLICATE_DEPOSIT");
    expect(def.actionable).toBe(true);
  });
});

describe("resolveContractError — unknown and future codes", () => {
  it("degrades gracefully for a completely unknown code", () => {
    const def = resolveContractError("FUTURE_UNKNOWN_CODE");
    expect(def.title).toBe(UNKNOWN_ERROR_DEFINITION.title);
    expect(def.description).toBe(UNKNOWN_ERROR_DEFINITION.description);
    expect(def.actionable).toBe(true);
  });

  it("degrades gracefully for an empty string code", () => {
    const def = resolveContractError("");
    expect(def.title).toBe(UNKNOWN_ERROR_DEFINITION.title);
  });

  it("degrades gracefully for a numeric string code", () => {
    const def = resolveContractError("9999");
    expect(def.title).toBe(UNKNOWN_ERROR_DEFINITION.title);
  });

  it("unknown error definition has a non-empty title and description", () => {
    expect(UNKNOWN_ERROR_DEFINITION.title.length).toBeGreaterThan(0);
    expect(UNKNOWN_ERROR_DEFINITION.description.length).toBeGreaterThan(0);
  });
});

describe("CONTRACT_ERROR_MAP — schema integrity", () => {
  it("every entry has a non-empty title", () => {
    for (const [code, def] of Object.entries(CONTRACT_ERROR_MAP)) {
      expect(def.title.length, `${code}.title is empty`).toBeGreaterThan(0);
    }
  });

  it("every entry has a non-empty description", () => {
    for (const [code, def] of Object.entries(CONTRACT_ERROR_MAP)) {
      expect(def.description.length, `${code}.description is empty`).toBeGreaterThan(0);
    }
  });

  it("every entry has a boolean actionable field", () => {
    for (const [code, def] of Object.entries(CONTRACT_ERROR_MAP)) {
      expect(typeof def.actionable, `${code}.actionable is not boolean`).toBe("boolean");
    }
  });
});
