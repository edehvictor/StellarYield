import { describe, it, expect } from "vitest";
import {
  CONTRACT_ENV_KEYS,
  DEFAULT_NETWORK_PASSPHRASE,
  DEFAULT_SOROBAN_RPC_URL,
  EFFECTIVE_PASSPHRASES,
  detectNetwork,
  detectNetworkFromPassphrase,
  explorerAccountUrl,
  getContractEnvOverrides,
  getDiagnosticRpcUrl,
  getEffectivePassphrase,
  getExportEnvironmentTag,
  getExplorerNetworkPath,
  getHorizonUrl,
  getNetworkPassphrase,
  getRpcUrl,
  isFuturenetPassphrase,
  resolveNetworkEnv,
  type EnvLike,
} from "./networkEnv";

const MAINNET_PASSPHRASE = "Public Global Stellar Network ; September 2015";
const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";
const FUTURENET_PASSPHRASE = "Test SDF Future Network ; October 2022";
const LOCAL_PASSPHRASE = "Standalone Network ; February 2021";

function env(vars: Record<string, string | undefined>): EnvLike {
  return vars;
}

describe("networkEnv (#1284)", () => {
  describe("defaults (empty env)", () => {
    it("signing defaults resolve to testnet RPC and passphrase", () => {
      const e = env({});
      expect(getRpcUrl(e)).toBe(DEFAULT_SOROBAN_RPC_URL);
      expect(getNetworkPassphrase(e)).toBe(DEFAULT_NETWORK_PASSPHRASE);
      expect(getRpcUrl(e)).toBe("https://soroban-testnet.stellar.org");
      expect(getNetworkPassphrase(e)).toBe("Test SDF Network ; September 2015");
    });

    it("registry detection with empty passphrase resolves to local (historical divergence from signing testnet default)", () => {
      expect(detectNetwork(env({}))).toBe("local");
      expect(detectNetwork(env({ VITE_NETWORK_PASSPHRASE: undefined }))).toBe("local");
    });

    it("diagnostics treat unset RPC and Horizon URLs as null (no default host)", () => {
      expect(getDiagnosticRpcUrl(env({}))).toBeNull();
      expect(getHorizonUrl(env({}))).toBeNull();
    });

    it("explorer defaults to the testnet path", () => {
      expect(getExplorerNetworkPath(env({}))).toBe("testnet");
      expect(explorerAccountUrl("GABC", env({}))).toBe(
        "https://stellar.expert/explorer/testnet/account/GABC",
      );
    });
  });

  describe("passphrase → network matrix", () => {
    it.each([
      [MAINNET_PASSPHRASE, "mainnet"],
      ["Public Global Stellar Network ; November 2015", "mainnet"],
      ["something mainnet something", "mainnet"],
      [TESTNET_PASSPHRASE, "testnet"],
      [FUTURENET_PASSPHRASE, "testnet"],
      ["", "local"],
      [undefined, "local"],
      ["local standalone network", "local"],
      ["Standalone Network ; February 2017", "testnet"],
      [LOCAL_PASSPHRASE, "testnet"],
    ])("%p → %s", (passphrase, expected) => {
      expect(detectNetworkFromPassphrase(passphrase)).toBe(expected);
      expect(detectNetwork(env({ VITE_NETWORK_PASSPHRASE: passphrase }))).toBe(expected);
    });

    it("matches local/standalone case-sensitively, exactly as the legacy helpers did", () => {
      // Historical rule: includes("local") || includes("standalone") — both
      // lowercase-only, so the canonical capitalized standalone passphrase
      // falls through to "testnet". Preserved for backward compatibility.
      expect(detectNetworkFromPassphrase("Standalone Network ; February 2021")).toBe("testnet");
      expect(detectNetworkFromPassphrase("standalone network")).toBe("local");
      expect(detectNetworkFromPassphrase("my local node")).toBe("local");
    });

    it("?? semantics: explicitly-empty VITE_NETWORK_PASSPHRASE stays empty for signing but detects local", () => {
      const e = env({ VITE_NETWORK_PASSPHRASE: "" });
      expect(getNetworkPassphrase(e)).toBe("");
      expect(detectNetwork(e)).toBe("local");
    });
  });

  describe("futurenet recognition", () => {
    it("flags futurenet passphrases while still mapping the id to testnet", () => {
      expect(isFuturenetPassphrase(FUTURENET_PASSPHRASE)).toBe(true);
      expect(isFuturenetPassphrase("Test SDF Future Network ; October 2022")).toBe(true);
      expect(isFuturenetPassphrase("test sdf future network")).toBe(true);
      expect(detectNetworkFromPassphrase(FUTURENET_PASSPHRASE)).toBe("testnet");
      const resolved = resolveNetworkEnv(env({ VITE_NETWORK_PASSPHRASE: FUTURENET_PASSPHRASE }));
      expect(resolved.isFuturenet).toBe(true);
      expect(resolved.network).toBe("testnet");
    });

    it("does not flag testnet, mainnet, or local passphrases", () => {
      expect(isFuturenetPassphrase(TESTNET_PASSPHRASE)).toBe(false);
      expect(isFuturenetPassphrase(MAINNET_PASSPHRASE)).toBe(false);
      expect(isFuturenetPassphrase(LOCAL_PASSPHRASE)).toBe(false);
      expect(isFuturenetPassphrase(undefined)).toBe(false);
      expect(isFuturenetPassphrase("")).toBe(false);
    });
  });

  describe("diagnostics helpers", () => {
    it("uses the raw passphrase when set, otherwise the per-network table", () => {
      expect(getEffectivePassphrase(env({ VITE_NETWORK_PASSPHRASE: MAINNET_PASSPHRASE }))).toBe(
        MAINNET_PASSPHRASE,
      );
      expect(getEffectivePassphrase(env({}))).toBe(EFFECTIVE_PASSPHRASES.local);
      expect(
        getEffectivePassphrase(env({ VITE_NETWORK_PASSPHRASE: "" })),
      ).toBe(EFFECTIVE_PASSPHRASES.local);
      expect(
        getEffectivePassphrase(env({ VITE_NETWORK_PASSPHRASE: TESTNET_PASSPHRASE })),
      ).toBe(TESTNET_PASSPHRASE);
    });

    it("passes through configured diagnostic URLs", () => {
      expect(getDiagnosticRpcUrl(env({ VITE_SOROBAN_RPC_URL: "https://rpc.example" }))).toBe(
        "https://rpc.example",
      );
      expect(getHorizonUrl(env({ VITE_HORIZON_URL: "https://horizon.example" }))).toBe(
        "https://horizon.example",
      );
    });
  });

  describe("explorer URLs", () => {
    it("uses the public path for mainnet and testnet path for everything else", () => {
      expect(getExplorerNetworkPath(env({ VITE_NETWORK_PASSPHRASE: MAINNET_PASSPHRASE }))).toBe(
        "public",
      );
      expect(getExplorerNetworkPath(env({ VITE_NETWORK_PASSPHRASE: TESTNET_PASSPHRASE }))).toBe(
        "testnet",
      );
      expect(getExplorerNetworkPath(env({ VITE_NETWORK_PASSPHRASE: LOCAL_PASSPHRASE }))).toBe(
        "testnet",
      );
      expect(
        getExplorerNetworkPath(env({ VITE_NETWORK_PASSPHRASE: FUTURENET_PASSPHRASE })),
      ).toBe("testnet");
      expect(getExplorerNetworkPath(env({}))).toBe("testnet");
    });

    it("builds account URLs and falls back to the base path without an address", () => {
      const mainnet = env({ VITE_NETWORK_PASSPHRASE: MAINNET_PASSPHRASE });
      expect(explorerAccountUrl("GXYZ", mainnet)).toBe(
        "https://stellar.expert/explorer/public/account/GXYZ",
      );
      expect(explorerAccountUrl(null, mainnet)).toBe("https://stellar.expert/explorer/public");
      expect(explorerAccountUrl(undefined, env({}))).toBe(
        "https://stellar.expert/explorer/testnet",
      );
    });
  });

  describe("export environment tag", () => {
    it("prefers VITE_STELLAR_NETWORK, then MODE, then production", () => {
      expect(getExportEnvironmentTag(env({ VITE_STELLAR_NETWORK: "mainnet", MODE: "test" }))).toBe(
        "mainnet",
      );
      expect(getExportEnvironmentTag(env({ MODE: "development" }))).toBe("development");
      expect(getExportEnvironmentTag(env({}))).toBe("production");
      expect(getExportEnvironmentTag(env({ VITE_STELLAR_NETWORK: "", MODE: undefined }))).toBe("");
    });
  });

  describe("contract env overrides", () => {
    it("maps every contract name to its exact legacy VITE_* variable", () => {
      expect(CONTRACT_ENV_KEYS).toEqual({
        vault: "VITE_CONTRACT_ID",
        zap: "VITE_ZAP_CONTRACT_ID",
        token: "VITE_TOKEN_CONTRACT_ID",
        governance: "VITE_GOVERNANCE_CONTRACT_ID",
        strategy: "VITE_STRATEGY_CONTRACT_ID",
        emissionController: "VITE_EMISSION_CONTROLLER_CONTRACT_ID",
        liquidStaking: "VITE_LIQUID_STAKING_CONTRACT_ID",
        stableswap: "VITE_STABLESWAP_CONTRACT_ID",
        vesting: "VITE_VESTING_CONTRACT_ID",
      });
    });

    it("returns overrides only for vars present in env", () => {
      const e = env({
        VITE_CONTRACT_ID: "CV",
        VITE_EMISSION_CONTROLLER_CONTRACT_ID: "CE",
        VITE_ZAP_CONTRACT_ID: undefined,
      });
      expect(getContractEnvOverrides(e)).toEqual({
        vault: "CV",
        emissionController: "CE",
      });
      expect(getContractEnvOverrides(env({}))).toEqual({});
    });

    it("includes explicitly-empty overrides (empty string is a value, not absence)", () => {
      expect(getContractEnvOverrides(env({ VITE_CONTRACT_ID: "" }))).toEqual({ vault: "" });
    });
  });

  describe("resolveNetworkEnv", () => {
    it("agrees with the granular helpers (parity)", () => {
      const cases: EnvLike[] = [
        env({}),
        env({ VITE_NETWORK_PASSPHRASE: TESTNET_PASSPHRASE }),
        env({ VITE_NETWORK_PASSPHRASE: MAINNET_PASSPHRASE }),
        env({ VITE_NETWORK_PASSPHRASE: FUTURENET_PASSPHRASE }),
        env({
          VITE_NETWORK_PASSPHRASE: LOCAL_PASSPHRASE,
          VITE_SOROBAN_RPC_URL: "https://rpc.local",
          VITE_HORIZON_URL: "https://horizon.local",
        }),
      ];
      for (const e of cases) {
        const resolved = resolveNetworkEnv(e);
        expect(resolved.network).toBe(detectNetwork(e));
        expect(resolved.networkPassphrase).toBe(getNetworkPassphrase(e));
        expect(resolved.rpcUrl).toBe(getRpcUrl(e));
        expect(resolved.diagnosticRpcUrl).toBe(getDiagnosticRpcUrl(e));
        expect(resolved.horizonUrl).toBe(getHorizonUrl(e));
        expect(resolved.effectivePassphrase).toBe(getEffectivePassphrase(e));
        expect(resolved.explorerPath).toBe(getExplorerNetworkPath(e));
        expect(resolved.isFuturenet).toBe(isFuturenetPassphrase(e.VITE_NETWORK_PASSPHRASE));
        expect(resolved.isMainnet).toBe(detectNetwork(e) === "mainnet");
      }
    });

    it("resolves a full mainnet view", () => {
      const resolved = resolveNetworkEnv(
        env({
          VITE_NETWORK_PASSPHRASE: MAINNET_PASSPHRASE,
          VITE_SOROBAN_RPC_URL: "https://soroban-rpc.mainnet.stellar.org",
          VITE_HORIZON_URL: "https://horizon.stellar.org",
        }),
      );
      expect(resolved).toMatchObject({
        network: "mainnet",
        networkPassphrase: MAINNET_PASSPHRASE,
        rpcUrl: "https://soroban-rpc.mainnet.stellar.org",
        diagnosticRpcUrl: "https://soroban-rpc.mainnet.stellar.org",
        horizonUrl: "https://horizon.stellar.org",
        effectivePassphrase: MAINNET_PASSPHRASE,
        explorerPath: "public",
        isFuturenet: false,
        isMainnet: true,
      });
    });
  });
});
