/**
 * Integrations Route Tests
 *
 * Tests for integration enable/disable endpoints with credential validation.
 */

import request from "supertest";
import express, { Express } from "express";
import integrationsRouter from "../integrations";

describe("Integrations Routes", () => {
  let app: Express;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use("/api/integrations", integrationsRouter);
  });

  const originalEnv = process.env;

  afterEach(() => {
    process.env = originalEnv;
  });

  // ─────────────────────────────────────────────────────────────────
  // GET /validate/:provider
  // ─────────────────────────────────────────────────────────────────

  describe("GET /api/integrations/validate/:provider", () => {
    describe("validation response structure", () => {
      it("should return proper validation response structure", async () => {
        process.env.ONRAMP_PROVIDER_API_KEY = "valid_key";

        const res = await request(app).get("/api/integrations/validate/onramp");

        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty("canEnable");
        expect(res.body).toHaveProperty("validation");
        expect(res.body).toHaveProperty("timestamp");
        expect(res.body.validation).toHaveProperty("status");
        expect(res.body.validation).toHaveProperty("provider");
        expect(res.body.validation).toHaveProperty("message");
      });
    });

    describe("on-ramp validation", () => {
      it("should return canEnable=true for valid on-ramp credentials", async () => {
        process.env.ONRAMP_PROVIDER_API_KEY = "valid_onramp_key";

        const res = await request(app).get("/api/integrations/validate/onramp");

        expect(res.status).toBe(200);
        expect(res.body.canEnable).toBe(true);
        expect(res.body.validation.status).toBe("accepted");
      });

      it("should return canEnable=false for missing on-ramp credentials", async () => {
        delete process.env.ONRAMP_PROVIDER_API_KEY;

        const res = await request(app).get("/api/integrations/validate/onramp");

        expect(res.status).toBe(200);
        expect(res.body.canEnable).toBe(false);
        expect(res.body.validation.status).toBe("missing");
        expect(res.body.validation.missingFields).toContain("ONRAMP_PROVIDER_API_KEY");
      });

      it("should return canEnable=false for mock on-ramp key", async () => {
        process.env.ONRAMP_PROVIDER_API_KEY = "mock-server-side-api-key";

        const res = await request(app).get("/api/integrations/validate/onramp");

        expect(res.status).toBe(200);
        expect(res.body.canEnable).toBe(false);
        expect(res.body.validation.status).toBe("invalid");
      });
    });

    describe("off-ramp validation", () => {
      it("should return canEnable=true for valid off-ramp credentials", async () => {
        process.env.OFFRAMP_API_KEY = "valid_offramp_key";
        process.env.OFFRAMP_BASE_URL = "https://api.moonpay.com/v1";

        const res = await request(app).get("/api/integrations/validate/offramp");

        expect(res.status).toBe(200);
        expect(res.body.canEnable).toBe(true);
        expect(res.body.validation.status).toBe("accepted");
      });

      it("should return canEnable=false for missing off-ramp API key", async () => {
        delete process.env.OFFRAMP_API_KEY;
        process.env.OFFRAMP_BASE_URL = "https://api.moonpay.com/v1";

        const res = await request(app).get("/api/integrations/validate/offramp");

        expect(res.status).toBe(200);
        expect(res.body.canEnable).toBe(false);
        expect(res.body.validation.status).toBe("missing");
      });

      it("should return canEnable=false for invalid off-ramp URL", async () => {
        process.env.OFFRAMP_API_KEY = "valid_key";
        process.env.OFFRAMP_BASE_URL = "not-a-valid-url";

        const res = await request(app).get("/api/integrations/validate/offramp");

        expect(res.status).toBe(200);
        expect(res.body.canEnable).toBe(false);
        expect(res.body.validation.status).toBe("invalid");
      });
    });

    describe("google sheets validation", () => {
      it("should return canEnable=true for valid Google Sheets credentials", async () => {
        process.env.GOOGLE_CLIENT_ID = "valid_client_id";
        process.env.GOOGLE_CLIENT_SECRET = "valid_client_secret";

        const res = await request(app).get("/api/integrations/validate/googleSheets");

        expect(res.status).toBe(200);
        expect(res.body.canEnable).toBe(true);
        expect(res.body.validation.status).toBe("accepted");
      });

      it("should return canEnable=false for placeholder Google Sheets credentials", async () => {
        process.env.GOOGLE_CLIENT_ID = "YOUR_CLIENT_ID";
        process.env.GOOGLE_CLIENT_SECRET = "valid_secret";

        const res = await request(app).get("/api/integrations/validate/googleSheets");

        expect(res.status).toBe(200);
        expect(res.body.canEnable).toBe(false);
        expect(res.body.validation.status).toBe("invalid");
      });
    });

    describe("llm validation (optional)", () => {
      it("should return canEnable=false and configured=false when no LLM key", async () => {
        delete process.env.GEMINI_API_KEY;
        delete process.env.OPENAI_API_KEY;

        const res = await request(app).get("/api/integrations/validate/llm");

        expect(res.status).toBe(200);
        expect(res.body.canEnable).toBe(false);
        expect(res.body.validation.status).toBe("optional");
        expect(res.body.validation.configured).toBe(false);
      });

      it("should return canEnable=true for configured Gemini", async () => {
        process.env.GEMINI_API_KEY = "valid_gemini_key";
        process.env.LLM_PROVIDER = "gemini";

        const res = await request(app).get("/api/integrations/validate/llm");

        expect(res.status).toBe(200);
        expect(res.body.canEnable).toBe(true);
        expect(res.body.validation.status).toBe("optional");
        expect(res.body.validation.configured).toBe(true);
      });
    });

    describe("pinata validation (optional)", () => {
      it("should return canEnable=false when Pinata not configured", async () => {
        delete process.env.PINATA_JWT;

        const res = await request(app).get("/api/integrations/validate/pinata");

        expect(res.status).toBe(200);
        expect(res.body.canEnable).toBe(false);
        expect(res.body.validation.status).toBe("optional");
        expect(res.body.validation.configured).toBe(false);
      });

      it("should return canEnable=true when Pinata configured", async () => {
        process.env.PINATA_JWT = "valid_jwt_token";

        const res = await request(app).get("/api/integrations/validate/pinata");

        expect(res.status).toBe(200);
        expect(res.body.canEnable).toBe(true);
        expect(res.body.validation.configured).toBe(true);
      });
    });

    describe("error handling", () => {
      it("should return 400 for invalid provider type", async () => {
        const res = await request(app).get("/api/integrations/validate/unknown");

        expect(res.status).toBe(400);
        expect(res.body.error).toBe("INVALID_PROVIDER");
      });

      it("should return error message with valid provider list", async () => {
        const res = await request(app).get("/api/integrations/validate/invalid");

        expect(res.status).toBe(400);
        expect(res.body.message).toContain("Valid providers");
      });
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // GET /status
  // ─────────────────────────────────────────────────────────────────

  describe("GET /api/integrations/status", () => {
    it("should return status for all providers", async () => {
      process.env.ONRAMP_PROVIDER_API_KEY = "valid_key";
      delete process.env.OFFRAMP_API_KEY;
      process.env.GOOGLE_CLIENT_ID = "valid_id";
      process.env.GOOGLE_CLIENT_SECRET = "valid_secret";
      delete process.env.GEMINI_API_KEY;
      delete process.env.OPENAI_API_KEY;
      delete process.env.PINATA_JWT;

      const res = await request(app).get("/api/integrations/status");

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("canEnable");
      expect(res.body).toHaveProperty("details");
      expect(res.body).toHaveProperty("timestamp");
      expect(Object.keys(res.body.canEnable)).toContain("onramp");
      expect(Object.keys(res.body.canEnable)).toContain("offramp");
      expect(Object.keys(res.body.canEnable)).toContain("googleSheets");
      expect(Object.keys(res.body.canEnable)).toContain("llm");
      expect(Object.keys(res.body.canEnable)).toContain("pinata");
    });

    it("should correctly reflect which providers can be enabled", async () => {
      process.env.ONRAMP_PROVIDER_API_KEY = "valid_key";
      delete process.env.OFFRAMP_API_KEY;
      process.env.GOOGLE_CLIENT_ID = "valid_id";
      process.env.GOOGLE_CLIENT_SECRET = "valid_secret";
      process.env.GEMINI_API_KEY = "valid_gemini";
      delete process.env.PINATA_JWT;

      const res = await request(app).get("/api/integrations/status");

      expect(res.status).toBe(200);
      expect(res.body.canEnable.onramp).toBe(true);
      expect(res.body.canEnable.offramp).toBe(false);
      expect(res.body.canEnable.googleSheets).toBe(true);
      expect(res.body.canEnable.llm).toBe(true);
      expect(res.body.canEnable.pinata).toBe(false);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // POST /enable/:provider
  // ─────────────────────────────────────────────────────────────────

  describe("POST /api/integrations/enable/:provider", () => {
    describe("successful enable", () => {
      it("should enable on-ramp with valid credentials", async () => {
        process.env.ONRAMP_PROVIDER_API_KEY = "valid_onramp_key";

        const res = await request(app).post("/api/integrations/enable/onramp");

        expect(res.status).toBe(200);
        expect(res.body.enabled).toBe(true);
        expect(res.body.validation.status).toBe("accepted");
        expect(res.body.message).toContain("enabled");
      });

      it("should enable optional provider when configured", async () => {
        process.env.PINATA_JWT = "valid_jwt";

        const res = await request(app).post("/api/integrations/enable/pinata");

        expect(res.status).toBe(200);
        expect(res.body.enabled).toBe(true);
        expect(res.body.validation.configured).toBe(true);
      });
    });

    describe("failed enable with actionable message", () => {
      it("should return 400 with actionable message for missing credentials", async () => {
        delete process.env.ONRAMP_PROVIDER_API_KEY;

        const res = await request(app).post("/api/integrations/enable/onramp");

        expect(res.status).toBe(400);
        expect(res.body.enabled).toBe(false);
        expect(res.body.validation.status).toBe("missing");
        expect(res.body.error).toBe("MISSING_CREDENTIALS");
        expect(res.body.validation.actionable).toBe(true);
        expect(res.body.validation.message).toContain("configure");
      });

      it("should return 400 with actionable message for invalid credentials", async () => {
        process.env.ONRAMP_PROVIDER_API_KEY = "mock-server-side-api-key";

        const res = await request(app).post("/api/integrations/enable/onramp");

        expect(res.status).toBe(400);
        expect(res.body.enabled).toBe(false);
        expect(res.body.validation.status).toBe("invalid");
        expect(res.body.error).toBe("INVALID_CREDENTIALS");
        expect(res.body.validation.actionable).toBe(true);
      });

      it("should return 400 for unconfigured optional provider", async () => {
        delete process.env.PINATA_JWT;

        const res = await request(app).post("/api/integrations/enable/pinata");

        expect(res.status).toBe(400);
        expect(res.body.enabled).toBe(false);
      });
    });

    describe("error handling", () => {
      it("should return 400 for invalid provider type", async () => {
        const res = await request(app).post("/api/integrations/enable/unknown");

        expect(res.status).toBe(400);
        expect(res.body.enabled).toBe(false);
        expect(res.body.error).toBe("INVALID_PROVIDER");
      });
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // POST /disable/:provider
  // ─────────────────────────────────────────────────────────────────

  describe("POST /api/integrations/disable/:provider", () => {
    it("should successfully disable an integration", async () => {
      const res = await request(app).post("/api/integrations/disable/onramp");

      expect(res.status).toBe(200);
      expect(res.body.disabled).toBe(true);
      expect(res.body.provider).toBe("onramp");
      expect(res.body.message).toContain("disabled");
    });

    it("should return 400 for invalid provider type", async () => {
      const res = await request(app).post("/api/integrations/disable/unknown");

      expect(res.status).toBe(400);
      expect(res.body.disabled).toBe(false);
      expect(res.body.error).toBe("INVALID_PROVIDER");
    });
  });
});
