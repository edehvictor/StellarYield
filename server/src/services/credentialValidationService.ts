/**
 * Credential Validation Service
 *
 * Validates provider credentials before integrations are enabled.
 * Returns typed validation results for missing, invalid, and accepted credentials.
 */

import {
  ProviderType,
  CredentialValidationResult,
  MissingCredentialsResult,
  InvalidCredentialsResult,
  AcceptedCredentialsResult,
  OptionalProviderResult,
} from "../utils/credentialValidation";

/**
 * Validates on-ramp provider credentials
 */
function validateOnRampCredentials(): CredentialValidationResult {
  const apiKey = process.env.ONRAMP_PROVIDER_API_KEY?.trim();

  if (!apiKey) {
    return {
      status: "missing",
      provider: "onramp",
      missingFields: ["ONRAMP_PROVIDER_API_KEY"],
      message:
        "On-ramp integration requires ONRAMP_PROVIDER_API_KEY environment variable. " +
        "Please configure your on-ramp provider API key to enable this integration.",
      actionable: true,
    } as MissingCredentialsResult;
  }

  // Validate API key format (should not be mock/placeholder)
  if (apiKey === "mock-server-side-api-key") {
    return {
      status: "invalid",
      provider: "onramp",
      reason: "API key is using mock/placeholder value",
      message:
        "On-ramp integration API key is not properly configured. " +
        "Please set a valid ONRAMP_PROVIDER_API_KEY in your environment.",
      actionable: true,
      retryable: true,
    } as InvalidCredentialsResult;
  }

  return {
    status: "accepted",
    provider: "onramp",
    message: "On-ramp provider credentials are valid and integration is ready to be enabled.",
    actionable: false,
  } as AcceptedCredentialsResult;
}

/**
 * Validates off-ramp provider credentials
 */
function validateOffRampCredentials(): CredentialValidationResult {
  const apiKey = process.env.OFFRAMP_API_KEY?.trim();
  const baseUrl = process.env.OFFRAMP_BASE_URL?.trim();

  const missingFields: string[] = [];
  if (!apiKey) missingFields.push("OFFRAMP_API_KEY");
  if (!baseUrl) missingFields.push("OFFRAMP_BASE_URL");

  if (missingFields.length > 0) {
    return {
      status: "missing",
      provider: "offramp",
      missingFields,
      message:
        `Off-ramp integration requires: ${missingFields.join(", ")}. ` +
        "Please configure these environment variables to enable off-ramp functionality.",
      actionable: true,
    } as MissingCredentialsResult;
  }

  // Validate URL format
  if (baseUrl && !isValidUrl(baseUrl)) {
    return {
      status: "invalid",
      provider: "offramp",
      reason: "OFFRAMP_BASE_URL is not a valid URL",
      message:
        "Off-ramp base URL is invalid. Please verify OFFRAMP_BASE_URL is a proper HTTP/HTTPS URL.",
      actionable: true,
      retryable: true,
    } as InvalidCredentialsResult;
  }

  return {
    status: "accepted",
    provider: "offramp",
    message: "Off-ramp provider credentials are valid and integration is ready to be enabled.",
    actionable: false,
  } as AcceptedCredentialsResult;
}

/**
 * Validates Google Sheets OAuth credentials
 */
function validateGoogleSheetsCredentials(): CredentialValidationResult {
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();

  const missingFields: string[] = [];
  if (!clientId) missingFields.push("GOOGLE_CLIENT_ID");
  if (!clientSecret) missingFields.push("GOOGLE_CLIENT_SECRET");

  if (missingFields.length > 0) {
    return {
      status: "missing",
      provider: "googleSheets",
      missingFields,
      message:
        `Google Sheets integration requires: ${missingFields.join(", ")}. ` +
        "Please configure Google OAuth credentials to enable spreadsheet export.",
      actionable: true,
    } as MissingCredentialsResult;
  }

  // Validate that credentials are not placeholder values
  if (clientId?.startsWith("YOUR_") || clientSecret?.startsWith("YOUR_")) {
    return {
      status: "invalid",
      provider: "googleSheets",
      reason: "OAuth credentials are using placeholder values",
      message:
        "Google Sheets OAuth credentials are not properly configured. " +
        "Please set valid GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET values.",
      actionable: true,
      retryable: true,
    } as InvalidCredentialsResult;
  }

  return {
    status: "accepted",
    provider: "googleSheets",
    message: "Google Sheets OAuth credentials are configured and integration is ready to be enabled.",
    actionable: false,
  } as AcceptedCredentialsResult;
}

/**
 * Validates LLM provider credentials (optional)
 */
function validateLlmCredentials(): CredentialValidationResult {
  const geminiKey = process.env.GEMINI_API_KEY?.trim();
  const openaiKey = process.env.OPENAI_API_KEY?.trim();
  const llmProvider = process.env.LLM_PROVIDER?.trim() || "gemini";

  // At least one LLM provider must be configured
  const hasAtLeastOne = geminiKey || openaiKey;

  if (!hasAtLeastOne) {
    return {
      status: "optional",
      provider: "llm",
      configured: false,
      message:
        "LLM provider (Gemini or OpenAI) is not configured. " +
        "Risk analysis features will be disabled. " +
        "To enable, set GEMINI_API_KEY or OPENAI_API_KEY.",
      actionable: false,
    } as OptionalProviderResult;
  }

  // Check that the selected provider is configured
  if (llmProvider === "openai" && !openaiKey) {
    return {
      status: "invalid",
      provider: "llm",
      reason: `LLM_PROVIDER is set to 'openai' but OPENAI_API_KEY is not configured`,
      message:
        "LLM provider mismatch: LLM_PROVIDER is 'openai' but OPENAI_API_KEY is missing. " +
        "Either configure OPENAI_API_KEY or set LLM_PROVIDER to 'gemini'.",
      actionable: true,
      retryable: true,
    } as InvalidCredentialsResult;
  }

  if (llmProvider === "gemini" && !geminiKey) {
    return {
      status: "invalid",
      provider: "llm",
      reason: `LLM_PROVIDER is set to 'gemini' but GEMINI_API_KEY is not configured`,
      message:
        "LLM provider mismatch: LLM_PROVIDER is 'gemini' but GEMINI_API_KEY is missing. " +
        "Either configure GEMINI_API_KEY or set LLM_PROVIDER to 'openai'.",
      actionable: true,
      retryable: true,
    } as InvalidCredentialsResult;
  }

  return {
    status: "optional",
    provider: "llm",
    configured: true,
    message: `LLM provider (${llmProvider}) is configured and risk analysis features are enabled.`,
    actionable: false,
  } as OptionalProviderResult;
}

/**
 * Validates Pinata IPFS credentials (optional)
 */
function validatePinataCredentials(): CredentialValidationResult {
  const pinataJwt = process.env.PINATA_JWT?.trim();

  if (!pinataJwt) {
    return {
      status: "optional",
      provider: "pinata",
      configured: false,
      message:
        "Pinata IPFS integration is not configured. " +
        "Vault metadata will be stored using deterministic local CIDs. " +
        "To enable Pinata storage, set PINATA_JWT.",
      actionable: false,
    } as OptionalProviderResult;
  }

  return {
    status: "optional",
    provider: "pinata",
    configured: true,
    message: "Pinata IPFS integration is configured and vault metadata will be pinned.",
    actionable: false,
  } as OptionalProviderResult;
}

/**
 * Validates a specific provider's credentials
 */
export function validateProviderCredentials(
  provider: ProviderType
): CredentialValidationResult {
  switch (provider) {
    case "onramp":
      return validateOnRampCredentials();
    case "offramp":
      return validateOffRampCredentials();
    case "googleSheets":
      return validateGoogleSheetsCredentials();
    case "llm":
      return validateLlmCredentials();
    case "pinata":
      return validatePinataCredentials();
    default: {
      const exhaustive: never = provider;
      throw new Error(`Unknown provider: ${exhaustive}`);
    }
  }
}

/**
 * Validates all providers and returns their statuses
 */
export function validateAllProviders(): Record<ProviderType, CredentialValidationResult> {
  const providers: ProviderType[] = ["onramp", "offramp", "googleSheets", "llm", "pinata"];

  return {
    onramp: validateOnRampCredentials(),
    offramp: validateOffRampCredentials(),
    googleSheets: validateGoogleSheetsCredentials(),
    llm: validateLlmCredentials(),
    pinata: validatePinataCredentials(),
  };
}

/**
 * Validates a provider and returns whether it can be enabled
 */
export function canEnableProvider(provider: ProviderType): boolean {
  const result = validateProviderCredentials(provider);
  return (
    result.status === "accepted" ||
    (result.status === "optional" && result.configured)
  );
}

/**
 * Helper to validate URL format
 */
function isValidUrl(urlString: string): boolean {
  try {
    new URL(urlString);
    return true;
  } catch {
    return false;
  }
}
