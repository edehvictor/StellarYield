/**
 * Credential Validation Service Tests
 *
 * Tests for missing, invalid, and accepted credentials across all providers.
 */

import {
  validateProviderCredentials,
  validateAllProviders,
  canEnableProvider,
} from "../credentialValidationService";
import {
  MissingCredentialsResult,
  InvalidCredentialsResult,
  AcceptedCredentialsResult,
  OptionalProviderResult,
} from "../../utils/credentialValidation";

describe("Credential Validation Service", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    // Save original env and create fresh copy
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    // Restore original env
    process.env = originalEnv;
  });

  // ─────────────────────────────────────────────────────────────────
  // ON-RAMP PROVIDER TESTS
  // ─────────────────────────────────────────────────────────────────

  describe("OnRamp Provider", () => {
    describe("missing credentials", () => {
      it("should return missing status when ONRAMP_PROVIDER_API_KEY is not set", () => {
        delete process.env.ONRAMP_PROVIDER_API_KEY;

        const result = validateProviderCredentials("onramp");

        expect(result.status).toBe("missing");
        expect(result.provider).toBe("onramp");
        expect((result as MissingCredentialsResult).missingFields).toContain(
          "ONRAMP_PROVIDER_API_KEY"
        );
        expect(result.message).toContain("ONRAMP_PROVIDER_API_KEY");
        expect(result.actionable).toBe(true);
      });

      it("should return missing status when API key is empty string", () => {
        process.env.ONRAMP_PROVIDER_API_KEY = "";

        const result = validateProviderCredentials("onramp");

        expect(result.status).toBe("missing");
        expect(result.actionable).toBe(true);
      });

      it("should return missing status when API key is only whitespace", () => {
        process.env.ONRAMP_PROVIDER_API_KEY = "   ";

        const result = validateProviderCredentials("onramp");

        expect(result.status).toBe("missing");
        expect(result.actionable).toBe(true);
      });
    });

    describe("invalid credentials", () => {
      it("should return invalid status for mock/placeholder API key", () => {
        process.env.ONRAMP_PROVIDER_API_KEY = "mock-server-side-api-key";

        const result = validateProviderCredentials("onramp");

        expect(result.status).toBe("invalid");
        expect((result as InvalidCredentialsResult).reason).toContain("mock");
        expect((result as InvalidCredentialsResult).retryable).toBe(true);
        expect(result.actionable).toBe(true);
      });
    });

    describe("accepted credentials", () => {
      it("should return accepted status for valid API key", () => {
        process.env.ONRAMP_PROVIDER_API_KEY = "valid_test_api_key_12345";

        const result = validateProviderCredentials("onramp");

        expect(result.status).toBe("accepted");
        expect(result.provider).toBe("onramp");
        expect(result.actionable).toBe(false);
        expect(result.message).toContain("valid");
      });

      it("should trim whitespace from API key before validation", () => {
        process.env.ONRAMP_PROVIDER_API_KEY = "  valid_api_key_with_spaces  ";

        const result = validateProviderCredentials("onramp");

        expect(result.status).toBe("accepted");
      });
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // OFF-RAMP PROVIDER TESTS
  // ─────────────────────────────────────────────────────────────────

  describe("OffRamp Provider", () => {
    describe("missing credentials", () => {
      it("should return missing status when OFFRAMP_API_KEY is not set", () => {
        process.env.OFFRAMP_API_KEY = "valid_key";
        delete process.env.OFFRAMP_BASE_URL;

        const result = validateProviderCredentials("offramp");

        expect(result.status).toBe("missing");
        expect((result as MissingCredentialsResult).missingFields).toContain(
          "OFFRAMP_BASE_URL"
        );
        expect(result.actionable).toBe(true);
      });

      it("should return missing status when OFFRAMP_BASE_URL is not set", () => {
        delete process.env.OFFRAMP_API_KEY;
        process.env.OFFRAMP_BASE_URL = "https://api.example.com";

        const result = validateProviderCredentials("offramp");

        expect(result.status).toBe("missing");
        expect((result as MissingCredentialsResult).missingFields).toContain(
          "OFFRAMP_API_KEY"
        );
        expect(result.actionable).toBe(true);
      });

      it("should return missing status when both are not set", () => {
        delete process.env.OFFRAMP_API_KEY;
        delete process.env.OFFRAMP_BASE_URL;

        const result = validateProviderCredentials("offramp");

        expect(result.status).toBe("missing");
        expect((result as MissingCredentialsResult).missingFields).toHaveLength(2);
        expect((result as MissingCredentialsResult).missingFields).toContain(
          "OFFRAMP_API_KEY"
        );
        expect((result as MissingCredentialsResult).missingFields).toContain(
          "OFFRAMP_BASE_URL"
        );
      });
    });

    describe("invalid credentials", () => {
      it("should return invalid status for malformed URL", () => {
        process.env.OFFRAMP_API_KEY = "valid_key";
        process.env.OFFRAMP_BASE_URL = "not-a-valid-url";

        const result = validateProviderCredentials("offramp");

        expect(result.status).toBe("invalid");
        expect((result as InvalidCredentialsResult).reason).toContain("URL");
        expect((result as InvalidCredentialsResult).retryable).toBe(true);
        expect(result.actionable).toBe(true);
      });

      it("should reject URLs without protocol", () => {
        process.env.OFFRAMP_API_KEY = "valid_key";
        process.env.OFFRAMP_BASE_URL = "api.moonpay.com/v1";

        const result = validateProviderCredentials("offramp");

        expect(result.status).toBe("invalid");
      });
    });

    describe("accepted credentials", () => {
      it("should return accepted status for valid credentials", () => {
        process.env.OFFRAMP_API_KEY = "valid_offramp_key";
        process.env.OFFRAMP_BASE_URL = "https://api.moonpay.com/v1";

        const result = validateProviderCredentials("offramp");

        expect(result.status).toBe("accepted");
        expect(result.actionable).toBe(false);
      });

      it("should accept https URLs", () => {
        process.env.OFFRAMP_API_KEY = "key";
        process.env.OFFRAMP_BASE_URL = "https://secure.example.com/api";

        const result = validateProviderCredentials("offramp");

        expect(result.status).toBe("accepted");
      });

      it("should accept http URLs for development", () => {
        process.env.OFFRAMP_API_KEY = "key";
        process.env.OFFRAMP_BASE_URL = "http://localhost:3000";

        const result = validateProviderCredentials("offramp");

        expect(result.status).toBe("accepted");
      });
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // GOOGLE SHEETS PROVIDER TESTS
  // ─────────────────────────────────────────────────────────────────

  describe("Google Sheets Provider", () => {
    describe("missing credentials", () => {
      it("should return missing status when GOOGLE_CLIENT_ID is not set", () => {
        delete process.env.GOOGLE_CLIENT_ID;
        process.env.GOOGLE_CLIENT_SECRET = "valid_secret";

        const result = validateProviderCredentials("googleSheets");

        expect(result.status).toBe("missing");
        expect((result as MissingCredentialsResult).missingFields).toContain(
          "GOOGLE_CLIENT_ID"
        );
        expect(result.actionable).toBe(true);
      });

      it("should return missing status when GOOGLE_CLIENT_SECRET is not set", () => {
        process.env.GOOGLE_CLIENT_ID = "valid_id";
        delete process.env.GOOGLE_CLIENT_SECRET;

        const result = validateProviderCredentials("googleSheets");

        expect(result.status).toBe("missing");
        expect((result as MissingCredentialsResult).missingFields).toContain(
          "GOOGLE_CLIENT_SECRET"
        );
        expect(result.actionable).toBe(true);
      });

      it("should return missing status when both are not set", () => {
        delete process.env.GOOGLE_CLIENT_ID;
        delete process.env.GOOGLE_CLIENT_SECRET;

        const result = validateProviderCredentials("googleSheets");

        expect(result.status).toBe("missing");
        expect((result as MissingCredentialsResult).missingFields).toHaveLength(2);
      });
    });

    describe("invalid credentials", () => {
      it("should return invalid status for placeholder client ID", () => {
        process.env.GOOGLE_CLIENT_ID = "YOUR_CLIENT_ID";
        process.env.GOOGLE_CLIENT_SECRET = "YOUR_CLIENT_SECRET";

        const result = validateProviderCredentials("googleSheets");

        expect(result.status).toBe("invalid");
        expect((result as InvalidCredentialsResult).reason).toContain("placeholder");
        expect((result as InvalidCredentialsResult).retryable).toBe(true);
        expect(result.actionable).toBe(true);
      });

      it("should detect placeholder in client ID", () => {
        process.env.GOOGLE_CLIENT_ID = "YOUR_GOOGLE_CLIENT_ID";
        process.env.GOOGLE_CLIENT_SECRET = "valid_secret";

        const result = validateProviderCredentials("googleSheets");

        expect(result.status).toBe("invalid");
      });

      it("should detect placeholder in client secret", () => {
        process.env.GOOGLE_CLIENT_ID = "valid_id";
        process.env.GOOGLE_CLIENT_SECRET = "YOUR_SECRET";

        const result = validateProviderCredentials("googleSheets");

        expect(result.status).toBe("invalid");
      });
    });

    describe("accepted credentials", () => {
      it("should return accepted status for valid OAuth credentials", () => {
        process.env.GOOGLE_CLIENT_ID =
          "123456789-abc123def456.apps.googleusercontent.com";
        process.env.GOOGLE_CLIENT_SECRET = "GOCSPX-abc123def456xyz";

        const result = validateProviderCredentials("googleSheets");

        expect(result.status).toBe("accepted");
        expect(result.actionable).toBe(false);
      });
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // LLM PROVIDER TESTS (OPTIONAL)
  // ─────────────────────────────────────────────────────────────────

  describe("LLM Provider (Optional)", () => {
    describe("missing credentials", () => {
      it("should return optional with configured=false when no LLM keys are set", () => {
        delete process.env.GEMINI_API_KEY;
        delete process.env.OPENAI_API_KEY;

        const result = validateProviderCredentials("llm");

        expect(result.status).toBe("optional");
        expect((result as OptionalProviderResult).configured).toBe(false);
        expect(result.actionable).toBe(false);
        expect(result.message).toContain("not configured");
      });
    });

    describe("invalid credentials", () => {
      it("should return invalid when LLM_PROVIDER=openai but OPENAI_API_KEY missing", () => {
        process.env.LLM_PROVIDER = "openai";
        delete process.env.OPENAI_API_KEY;
        process.env.GEMINI_API_KEY = "gemini_key";

        const result = validateProviderCredentials("llm");

        expect(result.status).toBe("invalid");
        expect((result as InvalidCredentialsResult).reason).toContain("openai");
        expect((result as InvalidCredentialsResult).retryable).toBe(true);
        expect(result.actionable).toBe(true);
      });

      it("should return invalid when LLM_PROVIDER=gemini but GEMINI_API_KEY missing", () => {
        process.env.LLM_PROVIDER = "gemini";
        delete process.env.GEMINI_API_KEY;
        process.env.OPENAI_API_KEY = "openai_key";

        const result = validateProviderCredentials("llm");

        expect(result.status).toBe("invalid");
        expect((result as InvalidCredentialsResult).reason).toContain("gemini");
        expect((result as InvalidCredentialsResult).retryable).toBe(true);
        expect(result.actionable).toBe(true);
      });
    });

    describe("accepted credentials", () => {
      it("should return optional with configured=true for Gemini", () => {
        process.env.GEMINI_API_KEY = "valid_gemini_key";
        process.env.LLM_PROVIDER = "gemini";

        const result = validateProviderCredentials("llm");

        expect(result.status).toBe("optional");
        expect((result as OptionalProviderResult).configured).toBe(true);
        expect(result.message).toContain("gemini");
      });

      it("should return optional with configured=true for OpenAI", () => {
        process.env.OPENAI_API_KEY = "sk-valid_openai_key";
        process.env.LLM_PROVIDER = "openai";

        const result = validateProviderCredentials("llm");

        expect(result.status).toBe("optional");
        expect((result as OptionalProviderResult).configured).toBe(true);
        expect(result.message).toContain("openai");
      });

      it("should default to gemini when LLM_PROVIDER not set", () => {
        delete process.env.LLM_PROVIDER;
        process.env.GEMINI_API_KEY = "gemini_key";

        const result = validateProviderCredentials("llm");

        expect(result.status).toBe("optional");
        expect((result as OptionalProviderResult).configured).toBe(true);
        expect(result.message).toContain("gemini");
      });
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // PINATA PROVIDER TESTS (OPTIONAL)
  // ─────────────────────────────────────────────────────────────────

  describe("Pinata Provider (Optional)", () => {
    describe("missing credentials", () => {
      it("should return optional with configured=false when PINATA_JWT is not set", () => {
        delete process.env.PINATA_JWT;

        const result = validateProviderCredentials("pinata");

        expect(result.status).toBe("optional");
        expect((result as OptionalProviderResult).configured).toBe(false);
        expect(result.message).toContain("not configured");
      });
    });

    describe("accepted credentials", () => {
      it("should return optional with configured=true for valid JWT", () => {
        process.env.PINATA_JWT = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.valid_jwt";

        const result = validateProviderCredentials("pinata");

        expect(result.status).toBe("optional");
        expect((result as OptionalProviderResult).configured).toBe(true);
        expect(result.message).toContain("configured");
      });
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // BATCH VALIDATION TESTS
  // ─────────────────────────────────────────────────────────────────

  describe("validateAllProviders", () => {
    it("should return validation results for all providers", () => {
      delete process.env.ONRAMP_PROVIDER_API_KEY;
      delete process.env.OFFRAMP_API_KEY;
      process.env.GOOGLE_CLIENT_ID = "valid_id";
      process.env.GOOGLE_CLIENT_SECRET = "valid_secret";
      delete process.env.GEMINI_API_KEY;
      delete process.env.OPENAI_API_KEY;
      delete process.env.PINATA_JWT;

      const results = validateAllProviders();

      expect(results.onramp.status).toBe("missing");
      expect(results.offramp.status).toBe("missing");
      expect(results.googleSheets.status).toBe("accepted");
      expect(results.llm.status).toBe("optional");
      expect(results.pinata.status).toBe("optional");
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // CAN_ENABLE_PROVIDER HELPER TESTS
  // ─────────────────────────────────────────────────────────────────

  describe("canEnableProvider", () => {
    it("should return true for accepted provider", () => {
      process.env.ONRAMP_PROVIDER_API_KEY = "valid_key";

      const result = canEnableProvider("onramp");

      expect(result).toBe(true);
    });

    it("should return false for missing provider", () => {
      delete process.env.ONRAMP_PROVIDER_API_KEY;

      const result = canEnableProvider("onramp");

      expect(result).toBe(false);
    });

    it("should return false for invalid provider", () => {
      process.env.ONRAMP_PROVIDER_API_KEY = "mock-server-side-api-key";

      const result = canEnableProvider("onramp");

      expect(result).toBe(false);
    });

    it("should return true for optional provider that is configured", () => {
      process.env.PINATA_JWT = "valid_jwt";

      const result = canEnableProvider("pinata");

      expect(result).toBe(true);
    });

    it("should return false for optional provider that is not configured", () => {
      delete process.env.PINATA_JWT;

      const result = canEnableProvider("pinata");

      expect(result).toBe(false);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // MESSAGE AND ERROR HANDLING
  // ─────────────────────────────────────────────────────────────────

  describe("Error messages and user guidance", () => {
    it("should provide actionable message for missing credentials", () => {
      delete process.env.ONRAMP_PROVIDER_API_KEY;

      const result = validateProviderCredentials("onramp");

      expect(result.message).toContain("requires");
      expect(result.message).toContain("configure");
      expect(result.actionable).toBe(true);
    });

    it("should indicate retry possibility for invalid credentials", () => {
      process.env.ONRAMP_PROVIDER_API_KEY = "mock-server-side-api-key";

      const result = validateProviderCredentials("onramp");

      const invalid = result as InvalidCredentialsResult;
      expect(invalid.retryable).toBe(true);
      expect(result.message).toContain("valid");
    });

    it("should indicate integration is ready for accepted credentials", () => {
      process.env.ONRAMP_PROVIDER_API_KEY = "valid_key";

      const result = validateProviderCredentials("onramp");

      expect(result.message).toContain("valid");
      expect(result.message).toContain("enabled");
    });

    it("should provide guidance for optional providers when not configured", () => {
      delete process.env.PINATA_JWT;

      const result = validateProviderCredentials("pinata");

      expect(result.message).toContain("not configured");
      expect(result.message).toContain("deterministic");
    });
  });
});
