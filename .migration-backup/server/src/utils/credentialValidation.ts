/**
 * Provider Credential Validation
 *
 * Typed validation results for provider credentials before integration is enabled.
 * Ensures broken credentials do not create failing routes.
 */

/**
 * Supported provider integrations
 */
export type ProviderType =
  | "onramp"
  | "offramp"
  | "googleSheets"
  | "llm"
  | "pinata";

/**
 * Validation result for missing credentials
 */
export interface MissingCredentialsResult {
  status: "missing";
  provider: ProviderType;
  missingFields: string[];
  message: string;
  actionable: true;
}

/**
 * Validation result for invalid/expired credentials
 */
export interface InvalidCredentialsResult {
  status: "invalid";
  provider: ProviderType;
  reason: string;
  message: string;
  actionable: true;
  retryable?: boolean;
}

/**
 * Validation result for accepted/valid credentials
 */
export interface AcceptedCredentialsResult {
  status: "accepted";
  provider: ProviderType;
  message: string;
  actionable: false;
}

/**
 * Validation result for optional providers (e.g., Pinata, LLM)
 * that gracefully degrade without credentials
 */
export interface OptionalProviderResult {
  status: "optional";
  provider: ProviderType;
  configured: boolean;
  message: string;
  actionable: false;
}

/**
 * Union type of all possible validation results
 */
export type CredentialValidationResult =
  | MissingCredentialsResult
  | InvalidCredentialsResult
  | AcceptedCredentialsResult
  | OptionalProviderResult;

/**
 * Credential validation response when enabling an integration
 */
export interface CredentialValidationResponse {
  canEnable: boolean;
  validation: CredentialValidationResult;
  timestamp: Date;
}

/**
 * Helper to check if a validation result allows enabling
 */
export function canEnableIntegration(
  result: CredentialValidationResult
): boolean {
  return (
    result.status === "accepted" ||
    (result.status === "optional" && result.configured)
  );
}

/**
 * Helper to get user-friendly message
 */
export function getValidationMessage(result: CredentialValidationResult): string {
  return result.message;
}

/**
 * Helper to check if result requires action from user
 */
export function requiresAction(result: CredentialValidationResult): boolean {
  return result.actionable || (result.status === "optional" && !result.configured);
}
