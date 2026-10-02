/**
 * Tests for Soroban contract ID validation (issue #1397).
 */
import { describe, it, expect } from "vitest";
import {
  validateSorobanContractId,
  isValidSorobanContractId,
  getSorobanContractIdError,
  CONTRACT_ID_ERROR_MESSAGES,
} from "./sorobanContractId";

// Valid 56-char strkey contract IDs (start with C, base-32 alphabet)
const VALID_ID   = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";
const VALID_ID_2 = "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBSC4";

describe("validateSorobanContractId — valid inputs", () => {
  it("accepts a well-formed 56-char contract ID", () => {
    expect(validateSorobanContractId(VALID_ID)).toEqual({ valid: true });
  });

  it("accepts a second well-formed ID", () => {
    expect(validateSorobanContractId(VALID_ID_2)).toEqual({ valid: true });
  });

  it("accepts IDs containing digits 2–7", () => {
    const withDigits = "C234567" + "A".repeat(49);
    expect(validateSorobanContractId(withDigits)).toEqual({ valid: true });
  });

  it("trims surrounding whitespace before validating", () => {
    expect(validateSorobanContractId(`  ${VALID_ID}  `)).toEqual({ valid: true });
  });
});

describe("validateSorobanContractId — invalid inputs", () => {
  it("rejects an empty string with EMPTY", () => {
    const r = validateSorobanContractId("");
    expect(r).toEqual({ valid: false, reason: "EMPTY" });
  });

  it("rejects a whitespace-only string with EMPTY", () => {
    const r = validateSorobanContractId("   ");
    expect(r).toEqual({ valid: false, reason: "EMPTY" });
  });

  it("rejects null with EMPTY", () => {
    const r = validateSorobanContractId(null);
    expect(r).toEqual({ valid: false, reason: "EMPTY" });
  });

  it("rejects undefined with EMPTY", () => {
    const r = validateSorobanContractId(undefined);
    expect(r).toEqual({ valid: false, reason: "EMPTY" });
  });

  it("rejects a non-string with EMPTY", () => {
    expect(validateSorobanContractId(12345)).toEqual({ valid: false, reason: "EMPTY" });
  });

  it("rejects a 55-char ID with WRONG_LENGTH", () => {
    const short = VALID_ID.slice(0, 55);
    expect(validateSorobanContractId(short)).toEqual({ valid: false, reason: "WRONG_LENGTH" });
  });

  it("rejects a 57-char ID with WRONG_LENGTH", () => {
    const long = VALID_ID + "A";
    expect(validateSorobanContractId(long)).toEqual({ valid: false, reason: "WRONG_LENGTH" });
  });

  it("rejects an ID starting with G (account key) with WRONG_PREFIX", () => {
    const gKey = "G" + VALID_ID.slice(1);
    expect(validateSorobanContractId(gKey)).toEqual({ valid: false, reason: "WRONG_PREFIX" });
  });

  it("rejects an ID starting with lowercase with WRONG_PREFIX", () => {
    const lower = "c" + VALID_ID.slice(1);
    expect(validateSorobanContractId(lower)).toEqual({ valid: false, reason: "WRONG_PREFIX" });
  });

  it("rejects an ID containing '0' (invalid base-32 digit) with INVALID_CHARACTERS", () => {
    const withZero = "C" + "0".repeat(55);
    expect(validateSorobanContractId(withZero)).toEqual({ valid: false, reason: "INVALID_CHARACTERS" });
  });

  it("rejects an ID containing '1' (invalid base-32 digit) with INVALID_CHARACTERS", () => {
    const withOne = "C" + "1".repeat(55);
    expect(validateSorobanContractId(withOne)).toEqual({ valid: false, reason: "INVALID_CHARACTERS" });
  });

  it("rejects an ID containing '8' (invalid base-32 digit) with INVALID_CHARACTERS", () => {
    const withEight = "C" + "8".repeat(55);
    expect(validateSorobanContractId(withEight)).toEqual({ valid: false, reason: "INVALID_CHARACTERS" });
  });

  it("rejects an ID containing a hyphen with INVALID_CHARACTERS", () => {
    const withHyphen = "C" + "A".repeat(27) + "-" + "A".repeat(27);
    expect(validateSorobanContractId(withHyphen)).toEqual({ valid: false, reason: "INVALID_CHARACTERS" });
  });
});

describe("isValidSorobanContractId", () => {
  it("returns true for a valid ID", () => {
    expect(isValidSorobanContractId(VALID_ID)).toBe(true);
  });

  it("returns false for an empty string", () => {
    expect(isValidSorobanContractId("")).toBe(false);
  });

  it("returns false for wrong prefix", () => {
    expect(isValidSorobanContractId("G" + VALID_ID.slice(1))).toBe(false);
  });

  it("returns false for wrong length", () => {
    expect(isValidSorobanContractId(VALID_ID.slice(0, 10))).toBe(false);
  });
});

describe("getSorobanContractIdError", () => {
  it("returns null for a valid ID", () => {
    expect(getSorobanContractIdError(VALID_ID)).toBeNull();
  });

  it("returns the EMPTY message for an empty string", () => {
    expect(getSorobanContractIdError("")).toBe(CONTRACT_ID_ERROR_MESSAGES.EMPTY);
  });

  it("returns the WRONG_LENGTH message for a short ID", () => {
    expect(getSorobanContractIdError("CAAA")).toBe(
      CONTRACT_ID_ERROR_MESSAGES.WRONG_LENGTH,
    );
  });

  it("returns the WRONG_PREFIX message for a G-key", () => {
    const gKey = "G" + VALID_ID.slice(1);
    expect(getSorobanContractIdError(gKey)).toBe(
      CONTRACT_ID_ERROR_MESSAGES.WRONG_PREFIX,
    );
  });

  it("returns the INVALID_CHARACTERS message for digits outside 2–7", () => {
    const bad = "C" + "0".repeat(55);
    expect(getSorobanContractIdError(bad)).toBe(
      CONTRACT_ID_ERROR_MESSAGES.INVALID_CHARACTERS,
    );
  });
});

describe("CONTRACT_ID_ERROR_MESSAGES", () => {
  it("all error codes have non-empty messages", () => {
    const codes: Array<keyof typeof CONTRACT_ID_ERROR_MESSAGES> = [
      "EMPTY",
      "WRONG_LENGTH",
      "WRONG_PREFIX",
      "INVALID_CHARACTERS",
    ];
    for (const code of codes) {
      expect(typeof CONTRACT_ID_ERROR_MESSAGES[code]).toBe("string");
      expect(CONTRACT_ID_ERROR_MESSAGES[code].length).toBeGreaterThan(0);
    }
  });
});
