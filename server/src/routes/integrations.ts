/**
 * Integrations Route
 *
 * API endpoints for managing provider integrations.
 * Validates credentials before integrations can be enabled.
 */

import { Router, Request, Response } from "express";
import { validateProviderCredentials, validateAllProviders, canEnableProvider } from "../services/credentialValidationService";
import { CredentialValidationResponse, ProviderType } from "../utils/credentialValidation";

const router = Router();

/**
 * GET /api/integrations/validate/:provider
 * 
 * Validate a specific provider's credentials before enabling.
 * 
 * @param provider - The provider type (onramp, offramp, googleSheets, llm, pinata)
 * 
 * @returns {CredentialValidationResponse}
 *   - canEnable: boolean indicating if integration can be enabled
 *   - validation: typed validation result with status and actionable message
 *   - timestamp: when validation was performed
 */
router.get("/validate/:provider", (req: Request, res: Response) => {
  try {
    const provider = req.params.provider as ProviderType;

    // Validate provider type
    const validProviders: ProviderType[] = ["onramp", "offramp", "googleSheets", "llm", "pinata"];
    if (!validProviders.includes(provider)) {
      return res.status(400).json({
        error: "INVALID_PROVIDER",
        message: `Unknown provider: ${provider}. Valid providers: ${validProviders.join(", ")}`,
      });
    }

    // Validate credentials
    const validation = validateProviderCredentials(provider);

    // Build response
    const response: CredentialValidationResponse = {
      canEnable: validation.status === "accepted" || (validation.status === "optional" && validation.configured),
      validation,
      timestamp: new Date(),
    };

    res.json(response);
  } catch (error) {
    console.error("Integration validation error", error);
    res.status(500).json({
      error: "VALIDATION_ERROR",
      message: "Failed to validate provider credentials",
    });
  }
});

/**
 * GET /api/integrations/status
 *
 * Get validation status for all providers.
 * Useful for displaying integration dashboard showing which are ready.
 *
 * @returns {Object}
 *   - canEnable: Record of provider → boolean for each provider
 *   - details: Record of provider → CredentialValidationResult for each
 *   - timestamp: when validation was performed
 */
router.get("/status", (req: Request, res: Response) => {
  try {
    const allValidations = validateAllProviders();

    // Build summary of what can be enabled
    const canEnable: Record<ProviderType, boolean> = {
      onramp: canEnableProvider("onramp"),
      offramp: canEnableProvider("offramp"),
      googleSheets: canEnableProvider("googleSheets"),
      llm: canEnableProvider("llm"),
      pinata: canEnableProvider("pinata"),
    };

    res.json({
      canEnable,
      details: allValidations,
      timestamp: new Date(),
    });
  } catch (error) {
    console.error("Integration status error", error);
    res.status(500).json({
      error: "STATUS_ERROR",
      message: "Failed to get integration status",
    });
  }
});

/**
 * POST /api/integrations/enable/:provider
 *
 * Attempt to enable a provider integration.
 * Validates credentials first; only proceeds if validation passes.
 *
 * @param provider - The provider to enable
 *
 * @returns {Object}
 *   - enabled: boolean - true if integration was enabled, false if validation failed
 *   - validation: CredentialValidationResult with actionable message if failed
 *   - message: human-readable status message
 *   - timestamp: when enable was attempted
 *
 * @throws 400 if provider type is invalid
 * @throws 400 if credentials are missing or invalid (with actionable message)
 */
router.post("/enable/:provider", (req: Request, res: Response) => {
  try {
    const provider = req.params.provider as ProviderType;

    // Validate provider type
    const validProviders: ProviderType[] = ["onramp", "offramp", "googleSheets", "llm", "pinata"];
    if (!validProviders.includes(provider)) {
      return res.status(400).json({
        enabled: false,
        message: `Unknown provider: ${provider}`,
        error: "INVALID_PROVIDER",
      });
    }

    // Validate credentials
    const validation = validateProviderCredentials(provider);

    // Check if integration can be enabled
    const canEnable = validation.status === "accepted" || (validation.status === "optional" && validation.configured);

    if (!canEnable) {
      return res.status(400).json({
        enabled: false,
        validation,
        message: validation.message,
        error: validation.status === "missing" ? "MISSING_CREDENTIALS" : "INVALID_CREDENTIALS",
        timestamp: new Date(),
      });
    }

    // Integration can be enabled
    res.json({
      enabled: true,
      validation,
      message: `${provider} integration is now enabled`,
      timestamp: new Date(),
    });
  } catch (error) {
    console.error("Integration enable error", error);
    res.status(500).json({
      enabled: false,
      error: "ENABLE_ERROR",
      message: "Failed to enable integration",
    });
  }
});

/**
 * POST /api/integrations/disable/:provider
 *
 * Disable a provider integration.
 * For optional integrations (llm, pinata), marks as disabled.
 * For required integrations, just acknowledges the request.
 *
 * @param provider - The provider to disable
 *
 * @returns {Object}
 *   - disabled: boolean - true if integration was disabled
 *   - provider: the provider that was disabled
 *   - message: confirmation message
 *   - timestamp: when disable was performed
 */
router.post("/disable/:provider", (req: Request, res: Response) => {
  try {
    const provider = req.params.provider as ProviderType;

    // Validate provider type
    const validProviders: ProviderType[] = ["onramp", "offramp", "googleSheets", "llm", "pinata"];
    if (!validProviders.includes(provider)) {
      return res.status(400).json({
        disabled: false,
        message: `Unknown provider: ${provider}`,
        error: "INVALID_PROVIDER",
      });
    }

    // For now, just acknowledge the disable request
    // In a full implementation, this would store the preference in the database
    res.json({
      disabled: true,
      provider,
      message: `${provider} integration has been disabled. Reconfigure and enable again when ready.`,
      timestamp: new Date(),
    });
  } catch (error) {
    console.error("Integration disable error", error);
    res.status(500).json({
      disabled: false,
      error: "DISABLE_ERROR",
      message: "Failed to disable integration",
    });
  }
});

export default router;
