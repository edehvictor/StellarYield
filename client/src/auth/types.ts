/** Extension/browser wallet provider IDs */
export type ExtensionWalletProviderId = "freighter" | "xbull" | "albedo";

export type WalletProviderId = ExtensionWalletProviderId | "email" | "google" | "github";

export type WalletAddressType = "account" | "contract";

export type VerificationStatus = "verified" | "degraded";

export interface WalletSession {
  walletAddress: string;
  walletAddressType: WalletAddressType;
  providerId: WalletProviderId;
  providerLabel: string;
  sessionKeyAddress?: string;
  sessionSecret?: string;
  loginHint?: string;
  verificationStatus: VerificationStatus;
}

export interface ConnectWalletOptions {
  providerId?: WalletProviderId;
  identifier?: string;
}
