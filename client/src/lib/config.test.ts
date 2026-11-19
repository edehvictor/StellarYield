import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  checkApiDiagnostics,
  checkNetworkDiagnostics,
  checkRegistryDiagnostics,
  checkWalletDiagnostics,
  getSystemDiagnostics,
  maskAddress,
  maskUrl,
} from "./config";

// Mock the contracts registry JSON
vi.mock("../../../contracts/registry.json", () => ({
  default: {
    testnet: {
      vault: "CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526",
      zap: "CABAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAFNSZ",
      token: "CABQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGCK3",
      governance: "CACAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAINCW",
      strategy: "CACQKBIFAUCQKBIFAUCQKBIFAUCQKBIFAUCQKBIFAUCQKBIFAUCQLC2U",
      emissionController: "CADAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMSST",
      liquidStaking: "CADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP5KR",
      stableswap: "CAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQMCJ",
      vesting: "CAEQSCIJBEEQSCIJBEEQSCIJBEEQSCIJBEEQSCIJBEEQSCIJBEEQTD2L",
    },
    mainnet: {},
    local: {},
  },
}));

describe("Diagnostics & Config Module (#1037)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe("maskUrl & maskAddress sanitization", () => {
    it("masks sensitive query parameters in API and RPC URLs", () => {
      const urlWithKey = "https://soroban-rpc.mainnet.stellar.org?api_key=secret12345&foo=bar";
      const masked = maskUrl(urlWithKey);
      expect(masked).not.toContain("secret12345");
      expect(masked).toContain("api_key=******");
      expect(masked).toContain("foo=bar");
    });

    it("masks credentials in URL auth", () => {
      const urlWithAuth = "https://admin:mySecretPassword@api.stellaryield.io/v1";
      const masked = maskUrl(urlWithAuth);
      expect(masked).not.toContain("mySecretPassword");
      expect(masked).toContain("******");
    });

    it("masks public Stellar addresses safely", () => {
      const address = "GAYOAUGI465BOMRPHU233EHR2C7Q6X3TGVH3D4U3N7RPA73GZ3A2T3W2";
      expect(maskAddress(address)).toBe("GAYO...T3W2");
      expect(maskAddress(null)).toBeNull();
      expect(maskAddress("")).toBeNull();
      expect(maskAddress("short")).toBe("short");
    });
  });

  describe("checkApiDiagnostics", () => {
    it("returns healthy when valid remote API URL is configured", () => {
      const env = {
        VITE_API_BASE_URL: "https://api.stellaryield.io",
      } as unknown as ImportMetaEnv;

      const diag = checkApiDiagnostics(env);
      expect(diag.status).toBe("healthy");
      expect(diag.baseUrl).toBe("https://api.stellaryield.io");
      expect(diag.isConfigured).toBe(true);
      expect(diag.isLocalFallback).toBe(false);
      expect(diag.isValidFormat).toBe(true);
    });

    it("returns warning on local fallback when no environment variable is provided", () => {
      const env = {} as unknown as ImportMetaEnv;

      const diag = checkApiDiagnostics(env);
      // In node/test runtime, window is undefined or localhost so local runtime returns localhost:3001
      expect(diag.status).toBe("warning");
      expect(diag.isLocalFallback).toBe(true);
      expect(diag.isConfigured).toBe(false);
      expect(diag.hint).toContain("http://localhost:3001");
    });

    it("returns error with actionable message when URL format is invalid", () => {
      const env = {
        VITE_API_BASE_URL: "invalid-url-without-protocol",
      } as unknown as ImportMetaEnv;

      const diag = checkApiDiagnostics(env);
      expect(diag.status).toBe("error");
      expect(diag.isValidFormat).toBe(false);
      expect(diag.hint).toContain("Must start with http:// or https://");
    });
  });

  describe("checkWalletDiagnostics", () => {
    it("returns healthy when wallet is connected", () => {
      const session = {
        isConnected: true,
        address: "GAYOAUGI465BOMRPHU233EHR2C7Q6X3TGVH3D4U3N7RPA73GZ3A2T3W2",
        provider: "Freighter",
      };

      const diag = checkWalletDiagnostics(session);
      expect(diag.status).toBe("healthy");
      expect(diag.isConnected).toBe(true);
      expect(diag.maskedAddress).toBe("GAYO...T3W2");
      expect(diag.hint).toContain("Connected to Freighter");
    });

    it("returns unconfigured when disconnected and no extensions present", () => {
      const diag = checkWalletDiagnostics(null);
      expect(diag.status).toBe("unconfigured");
      expect(diag.isConnected).toBe(false);
      expect(diag.hint).toContain("No Stellar wallet extension detected");
    });
  });

  describe("checkNetworkDiagnostics", () => {
    it("identifies active network and passphrase", () => {
      const env = {
        VITE_NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
      } as unknown as ImportMetaEnv;

      const diag = checkNetworkDiagnostics(env);
      expect(diag.activeNetwork).toBe("testnet");
      expect(diag.passphrase).toBe("Test SDF Network ; September 2015");
      expect(diag.status).toBe("healthy");
    });
  });

  describe("checkRegistryDiagnostics", () => {
    it("detects configured contracts for testnet", () => {
      const diag = checkRegistryDiagnostics("testnet");
      expect(diag.status).toBe("healthy");
      expect(diag.totalContracts).toBe(9);
      expect(diag.configuredContracts).toBe(9);
      expect(diag.missingContracts).toHaveLength(0);
    });

    it("flags error when critical contracts like vault are missing", () => {
      const diag = checkRegistryDiagnostics("mainnet");
      expect(diag.status).toBe("error");
      expect(diag.missingContracts).toContain("vault");
      expect(diag.hint).toContain("Critical contract missing");
    });
  });

  describe("getSystemDiagnostics", () => {
    it("aggregates overall health across all dependencies", () => {
      const env = {
        VITE_API_BASE_URL: "https://api.stellaryield.io",
        VITE_NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
      } as unknown as ImportMetaEnv;

      const session = {
        isConnected: true,
        address: "GAYOAUGI465BOMRPHU233EHR2C7Q6X3TGVH3D4U3N7RPA73GZ3A2T3W2",
      };

      const sys = getSystemDiagnostics(env, session);
      expect(sys.overallStatus).toBe("healthy");
      expect(sys.api.status).toBe("healthy");
      expect(sys.wallet.status).toBe("healthy");
      expect(sys.registry.status).toBe("healthy");
      expect(sys.timestamp).toBeDefined();
    });

    it("returns error overall status when API URL is misconfigured", () => {
      const env = {
        VITE_API_BASE_URL: "broken-url-no-protocol",
      } as unknown as ImportMetaEnv;

      const sys = getSystemDiagnostics(env, null);
      expect(sys.overallStatus).toBe("error");
      expect(sys.api.status).toBe("error");
    });
  });
});
