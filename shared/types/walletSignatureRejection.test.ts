import { describe, expect, it } from "vitest";
import {
  classifyWalletSignatureError,
  DEFAULT_MAX_SIGNATURE_ATTEMPTS,
  isWalletSignatureRejection,
  SIGNATURE_REJECTION_COPY,
  WalletSignatureRejectionError,
} from "./walletSignatureRejection";

describe("wallet signature rejection classifier", () => {
  it("classifies a user-declined signature with retry and switch actions", () => {
    const rejection = classifyWalletSignatureError(
      new Error("User declined signing the transaction"),
      { provider: "freighter" },
    );

    expect(rejection.code).toBe("USER_REJECTED_SIGNATURE");
    expect(rejection.retryable).toBe(true);
    expect(rejection.actions).toEqual(["retry", "switch_wallet", "cancel"]);
    expect(rejection.provider).toBe("freighter");
    // Stable copy, not the provider's raw text.
    expect(rejection.message).toBe(
      SIGNATURE_REJECTION_COPY.USER_REJECTED_SIGNATURE.message,
    );
    expect(rejection.message).not.toContain("User declined signing");
  });

  it("classifies the SDK's WalletRejectedError wrapper", () => {
    const sdkError = new Error(
      "Wallet rejected signature: User rejected the request.",
    );
    sdkError.name = "WalletRejectedError";

    expect(isWalletSignatureRejection(sdkError)).toBe(true);
    expect(classifyWalletSignatureError(sdkError).code).toBe(
      "USER_REJECTED_SIGNATURE",
    );
  });

  it("offers reconnect for a locked wallet", () => {
    const rejection = classifyWalletSignatureError("Your wallet is locked.");

    expect(rejection.code).toBe("WALLET_LOCKED");
    expect(rejection.actions).toContain("reconnect");
  });

  it("classifies a signing timeout and keeps the original request recoverable", () => {
    const rejection = classifyWalletSignatureError(
      "Wallet did not respond before the signing request timed out",
    );

    expect(rejection.code).toBe("SIGNING_TIMEOUT");
    expect(rejection.retryable).toBe(true);
  });

  it("marks unsupported wallets as non-retryable with no retry action", () => {
    const rejection = classifyWalletSignatureError(
      "signTransaction is not supported for smart wallet sessions.",
    );

    expect(rejection.code).toBe("WALLET_UNSUPPORTED");
    expect(rejection.retryable).toBe(false);
    expect(rejection.actions).not.toContain("retry");
    expect(rejection.actions).toContain("switch_wallet");
  });

  it("removes retry after the attempt limit and explains why", () => {
    const rejection = classifyWalletSignatureError("User rejected", {
      attempt: DEFAULT_MAX_SIGNATURE_ATTEMPTS,
      maxAttempts: DEFAULT_MAX_SIGNATURE_ATTEMPTS,
    });

    expect(rejection.retryable).toBe(false);
    expect(rejection.remainingAttempts).toBe(0);
    expect(rejection.actions).not.toContain("retry");
    expect(rejection.guidance).toContain("switch wallets");
  });

  it("never echoes an unknown provider failure", () => {
    const rejection = classifyWalletSignatureError(
      "FREIGHTER_INTERNAL_9f3c: unexpected bridge teardown",
    );

    expect(rejection.code).toBe("UNKNOWN_SIGNING_FAILURE");
    expect(rejection.message).toBe(
      SIGNATURE_REJECTION_COPY.UNKNOWN_SIGNING_FAILURE.message,
    );
    expect(rejection.message).not.toContain("9f3c");
  });

  it("does not classify contract or network failures as signature rejections", () => {
    expect(
      isWalletSignatureRejection("Error(Contract, #10) Slippage exceeded"),
    ).toBe(false);
    expect(isWalletSignatureRejection("Network request failed")).toBe(false);
  });

  it("throws a typed error whose message is the stable copy", () => {
    const cause = new Error("User rejected in provider");
    const error = WalletSignatureRejectionError.from(cause);

    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe("USER_REJECTED_SIGNATURE");
    expect(error.message).toBe(
      SIGNATURE_REJECTION_COPY.USER_REJECTED_SIGNATURE.message,
    );
    expect(error.cause).toBe(cause);
  });
});
