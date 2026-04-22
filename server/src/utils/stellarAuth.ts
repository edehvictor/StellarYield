import { Keypair, StrKey } from "@stellar/stellar-sdk";

export type WalletAddressType = "account" | "contract";

export function getWalletAddressType(
  address: string,
): WalletAddressType | null {
  if (StrKey.isValidEd25519PublicKey(address)) {
    return "account";
  }

  if (StrKey.isValidContract(address)) {
    return "contract";
  }

  return null;
}

export function createAuthChallenge(input: {
  walletAddress: string;
  sessionKeyAddress: string;
  providerId?: string;
  loginHint?: string;
}) {
  const walletAddressType = getWalletAddressType(input.walletAddress);

  if (!walletAddressType) {
    throw new Error("Invalid wallet address.");
  }

  if (!StrKey.isValidEd25519PublicKey(input.sessionKeyAddress)) {
    throw new Error("Invalid session key address.");
  }

  const providerId = input.providerId?.trim().toLowerCase() || "freighter";
  const loginHint = input.loginHint?.trim().toLowerCase() || "anonymous";

  return {
    challenge: [
      "stellar-yield-auth",
      providerId,
      loginHint,
      input.walletAddress,
      input.sessionKeyAddress,
    ].join(":"),
    walletAddressType,
    acceptedSignerTypes:
      walletAddressType === "contract"
        ? ["session-key", "contract-wallet"]
        : ["freighter", "ed25519"],
  };
}

export function verifyAuthChallenge(input: {
  walletAddress: string;
  sessionKeyAddress: string;
  challenge: string;
  signature: string;
}) {
  const walletAddressType = getWalletAddressType(input.walletAddress);

  if (!walletAddressType) {
    throw new Error("Invalid wallet address.");
  }

  if (!StrKey.isValidEd25519PublicKey(input.sessionKeyAddress)) {
    throw new Error("Invalid session key address.");
  }

  if (!input.challenge?.trim()) {
    throw new Error("Challenge is required.");
  }

  if (!input.signature?.trim()) {
    throw new Error("Signature is required.");
  }

  return {
    verified: Keypair.fromPublicKey(input.sessionKeyAddress).verify(
      Buffer.from(input.challenge, "utf8"),
      Buffer.from(input.signature, "base64"),
    ),
    walletAddressType,
    acceptedSignerTypes:
      walletAddressType === "contract"
        ? ["session-key", "contract-wallet"]
        : ["freighter", "ed25519"],
  };
}
