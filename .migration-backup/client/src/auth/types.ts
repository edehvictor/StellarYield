/** Extension/browser wallet provider IDs */
export type ExtensionWalletProviderId = "freighter" | "xbull" | "albedo";

export type WalletProviderId = ExtensionWalletProviderId | "email" | "google" | "github";

export type WalletAddressType = "account" | "contract";

export type VerificationStatus = "verified" | "degraded";

export type SessionPermission = "read" | "sign" | "trade" | "govern";

export interface SessionOrigin {
  /** Browser tab ID for cross-tab correlation */
  tabId: string;
  /** Origin URL that created the session */
  origin: string;
  /** User-agent string at connection time */
  userAgent?: string;
}

export interface WalletSession {
  walletAddress: string;
  walletAddressType: WalletAddressType;
  providerId: WalletProviderId;
  providerLabel: string;
  sessionKeyAddress?: string;
  sessionSecret?: string;
  loginHint?: string;
  verificationStatus: VerificationStatus;
  connectedAt?: string;
  lastActivityAt?: string;
  /** When the session was last verified against the backend */
  lastVerifiedAt?: string;
  /** Active permissions granted to this session */
  permissions?: SessionPermission[];
  /** Origin metadata for this session */
  origin?: SessionOrigin;
  /** Whether the provider is confirmed available in this browser */
  providerAvailable?: boolean;
}

export interface ConnectWalletOptions {
  providerId?: WalletProviderId;
  identifier?: string;
}
