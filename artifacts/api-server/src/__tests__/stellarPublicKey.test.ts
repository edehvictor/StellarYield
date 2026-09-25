import { Keypair } from "@stellar/stellar-sdk";
import type { NextFunction, Request, Response } from "express";
import { describe, expect, it } from "vitest";
import { AccountLinkError } from "../lib/errors";
import {
  STELLAR_PUBLIC_KEY_LENGTH,
  STELLAR_PUBLIC_KEY_REJECTION_MESSAGES,
  isValidStellarPublicKey,
  parseStellarPublicKey,
} from "../lib/stellarPublicKey";
import {
  getValidatedStellarPublicKey,
  requireValidStellarPublicKey,
} from "../middlewares/stellarPublicKey";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function validKey(): string {
  return Keypair.random().publicKey();
}

/** Replaces the last base32 character while flipping a real (non-padding) bit. */
function withCorruptedChecksum(key: string): string {
  const lastIndex = key.length - 1;
  const charIndex = BASE32_ALPHABET.indexOf(key[lastIndex]);
  const flippedIndex = charIndex ^ 16; // toggle the MSB of the 5-bit group
  return key.slice(0, lastIndex) + BASE32_ALPHABET[flippedIndex];
}

interface MiddlewareOutcome {
  readonly nextCalled: boolean;
  readonly error: unknown;
  readonly locals: Record<string, unknown>;
}

function runMiddleware(body: unknown): MiddlewareOutcome {
  const req = { body } as unknown as Request;
  const res = { locals: {} } as unknown as Response;
  let nextCalled = false;
  let error: unknown;

  requireValidStellarPublicKey(req, res, ((err?: unknown) => {
    nextCalled = true;
    error = err;
  }) as NextFunction);

  return { nextCalled, error, locals: res.locals as Record<string, unknown> };
}

describe("parseStellarPublicKey", () => {
  it("accepts standard well-formed alphanumeric G... keys", () => {
    for (let i = 0; i < 5; i += 1) {
      const key = validKey();

      expect(key).toHaveLength(STELLAR_PUBLIC_KEY_LENGTH);
      expect(key.startsWith("G")).toBe(true);
      expect(parseStellarPublicKey(key)).toEqual({
        ok: true,
        publicKey: key,
      });
      expect(isValidStellarPublicKey(key)).toBe(true);
    }
  });

  it("trims surrounding whitespace from well-formed keys", () => {
    const key = validKey();

    expect(parseStellarPublicKey(`  ${key}\n`)).toEqual({
      ok: true,
      publicKey: key,
    });
  });

  it("rejects keys with the wrong prefix string", () => {
    const key = validKey();
    const wrongPrefix = "R" + key.slice(1);

    expect(parseStellarPublicKey(wrongPrefix)).toEqual({
      ok: false,
      rejection: "INVALID_PREFIX",
    });
  });

  it("rejects short keys and keys exceeding the length boundary", () => {
    const key = validKey();

    expect(parseStellarPublicKey(key.slice(0, 50))).toEqual({
      ok: false,
      rejection: "INVALID_LENGTH",
    });
    expect(parseStellarPublicKey(key.slice(0, 10))).toEqual({
      ok: false,
      rejection: "INVALID_LENGTH",
    });
    expect(parseStellarPublicKey(`${key}A`)).toEqual({
      ok: false,
      rejection: "INVALID_LENGTH",
    });
  });

  it("rejects non-alphanumeric patterns", () => {
    const key = validKey();
    const withSymbol = key.slice(0, 20) + "!" + key.slice(21);
    const withSpace = key.slice(0, 20) + " " + key.slice(21);
    const mixedCase = "G" + key.slice(1).toLowerCase();

    expect(parseStellarPublicKey(withSymbol)).toEqual({
      ok: false,
      rejection: "INVALID_CHARACTERS",
    });
    expect(parseStellarPublicKey(withSpace)).toEqual({
      ok: false,
      rejection: "INVALID_CHARACTERS",
    });
    expect(parseStellarPublicKey(mixedCase)).toEqual({
      ok: false,
      rejection: "INVALID_CHARACTERS",
    });
  });

  it("rejects keys failing the StrKey checksum", () => {
    const corrupted = withCorruptedChecksum(validKey());

    expect(parseStellarPublicKey(corrupted)).toEqual({
      ok: false,
      rejection: "STRKEY_DECODE_FAILED",
    });
  });

  it("rejects empty, blank, null, and non-string inputs cleanly", () => {
    expect(parseStellarPublicKey("")).toEqual({
      ok: false,
      rejection: "EMPTY",
    });
    expect(parseStellarPublicKey("    ")).toEqual({
      ok: false,
      rejection: "EMPTY",
    });
    expect(parseStellarPublicKey(null)).toEqual({
      ok: false,
      rejection: "MISSING",
    });
    expect(parseStellarPublicKey(undefined)).toEqual({
      ok: false,
      rejection: "MISSING",
    });
    expect(parseStellarPublicKey(1234567890)).toEqual({
      ok: false,
      rejection: "NOT_A_STRING",
    });
    expect(parseStellarPublicKey({ key: validKey() })).toEqual({
      ok: false,
      rejection: "NOT_A_STRING",
    });
  });

  it("exposes a stable detail message for every rejection reason", () => {
    for (const message of Object.values(STELLAR_PUBLIC_KEY_REJECTION_MESSAGES)) {
      expect(message).toBeTruthy();
      expect(message.startsWith("publicKey")).toBe(true);
    }
  });
});

describe("requireValidStellarPublicKey middleware", () => {
  it("passes valid keys through and stores the normalized value", () => {
    const key = validKey();
    const outcome = runMiddleware({ publicKey: `  ${key}  ` });

    expect(outcome.nextCalled).toBe(true);
    expect(outcome.error).toBeUndefined();
    expect(outcome.locals["stellarPublicKey"]).toBe(key);
  });

  it("rejects blank keys with a typed MISSING_PUBLIC_KEY error", () => {
    const outcome = runMiddleware({ publicKey: "   " });

    expect(outcome.nextCalled).toBe(true);
    expect(outcome.error).toBeInstanceOf(AccountLinkError);
    const apiError = outcome.error as AccountLinkError;
    expect(apiError.code).toBe("MISSING_PUBLIC_KEY");
    expect(apiError.status).toBe(400);
    expect(apiError.message).toBe(
      "publicKey is required to link a Stellar account.",
    );
  });

  it("rejects malformed keys with a typed INVALID_PUBLIC_KEY error", () => {
    const outcome = runMiddleware({ publicKey: "not-a-stellar-key" });

    expect(outcome.nextCalled).toBe(true);
    expect(outcome.error).toBeInstanceOf(AccountLinkError);
    const apiError = outcome.error as AccountLinkError;
    expect(apiError.code).toBe("INVALID_PUBLIC_KEY");
    expect(apiError.status).toBe(400);
    expect(apiError.message).toBe(
      "publicKey is not a valid Stellar public key.",
    );
    expect(apiError.details).toEqual([
      {
        path: "publicKey",
        message: STELLAR_PUBLIC_KEY_REJECTION_MESSAGES.INVALID_LENGTH,
      },
    ]);
  });

  it("rejects a missing body without crashing", () => {
    const outcome = runMiddleware(undefined);

    expect(outcome.nextCalled).toBe(true);
    expect((outcome.error as AccountLinkError).code).toBe(
      "MISSING_PUBLIC_KEY",
    );
  });

  it("throws a typed error when reading a key the middleware never validated", () => {
    const res = { locals: {} } as unknown as Response;

    expect(() => getValidatedStellarPublicKey(res)).toThrow(AccountLinkError);
    expect(() => getValidatedStellarPublicKey(res)).toThrow(
      "publicKey is required to link a Stellar account.",
    );
  });
});
