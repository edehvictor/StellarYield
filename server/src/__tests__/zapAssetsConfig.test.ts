import {
  getZapSupportedAssetsPayload,
  initializeZapSupportedAssetsCache,
  loadZapSupportedAssetsPayload,
  resetZapSupportedAssetsCache,
  validateZapAssetsJsonEntry,
  type ZapSupportedAssetsPayload,
} from "../config/zapAssetsConfig";

const KEYS = [
  "ZAP_ASSETS_JSON",
  "XLM_SAC_CONTRACT_ID",
  "USDC_SAC_CONTRACT_ID",
  "AQUA_SAC_CONTRACT_ID",
  "VAULT_TOKEN_CONTRACT_ID",
  "VAULT_CONTRACT_ID",
] as const;

describe("loadZapSupportedAssetsPayload", () => {
  let snapshot: Partial<Record<(typeof KEYS)[number], string | undefined>>;

  beforeEach(() => {
    snapshot = {};
    for (const k of KEYS) snapshot[k] = process.env[k];
  });

  afterEach(() => {
    for (const k of KEYS) {
      const v = snapshot[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("parses ZAP_ASSETS_JSON including optional iconUrl", () => {
    process.env.ZAP_ASSETS_JSON = JSON.stringify([
      {
        symbol: "XLM",
        name: "Stellar Lumens",
        contractId: "CDXLM",
        decimals: 7,
        iconUrl: "https://example.com/xlm.png",
      },
    ]);
    process.env.VAULT_TOKEN_CONTRACT_ID = "VAULT";
    process.env.VAULT_CONTRACT_ID = "YIELD";

    const p = loadZapSupportedAssetsPayload(process.env);

    expect(p.assets[0]?.iconUrl).toBe("https://example.com/xlm.png");
    expect(p.vaultToken.contractId).toBe("VAULT");
    expect(p.vaultContractId).toBe("YIELD");
  });

  it("throws when ZAP_ASSETS_JSON is malformed", () => {
    process.env.ZAP_ASSETS_JSON = "not-json";
    expect(() => loadZapSupportedAssetsPayload(process.env)).toThrow(/valid JSON/);
  });

  it("throws when ZAP_ASSETS_JSON is an empty array", () => {
    process.env.ZAP_ASSETS_JSON = "[]";
    expect(() => loadZapSupportedAssetsPayload(process.env)).toThrow(
      /at least one asset/,
    );
  });

  it("falls back to SAC env vars when ZAP_ASSETS_JSON is unset", () => {
    delete process.env.ZAP_ASSETS_JSON;
    process.env.XLM_SAC_CONTRACT_ID = "CDXLM2";
    process.env.USDC_SAC_CONTRACT_ID = "";
    process.env.AQUA_SAC_CONTRACT_ID = "";

    const p = loadZapSupportedAssetsPayload(process.env);

    expect(p.assets.some((a) => a.symbol === "XLM" && a.contractId === "CDXLM2")).toBe(
      true,
    );
    expect(p.assets.every((a) => a.contractId.length > 0)).toBe(true);
  });
});

describe("validateZapAssetsJsonEntry", () => {
  it("rejects non-integer decimals", () => {
    expect(() =>
      validateZapAssetsJsonEntry({ symbol: "A", name: "A", contractId: "C", decimals: 7.1 }, 0),
    ).toThrow(/decimals/);
  });
});

describe("initializeZapSupportedAssetsCache", () => {
  let snapshot: Partial<Record<(typeof KEYS)[number], string | undefined>>;

  beforeEach(() => {
    snapshot = {};
    for (const k of KEYS) snapshot[k] = process.env[k];
    resetZapSupportedAssetsCache();
  });

  afterEach(() => {
    for (const k of KEYS) {
      const v = snapshot[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    resetZapSupportedAssetsCache();
  });

  it("initializes cache with provided env", () => {
    process.env.ZAP_ASSETS_JSON = JSON.stringify([
      { symbol: "XLM", name: "Stellar Lumens", contractId: "CDXLM", decimals: 7 },
    ]);
    process.env.VAULT_TOKEN_CONTRACT_ID = "VAULT";
    process.env.VAULT_CONTRACT_ID = "YIELD";

    const payload = initializeZapSupportedAssetsCache(process.env);

    expect(payload.assets).toHaveLength(1);
    expect(payload.assets[0]?.symbol).toBe("XLM");
    expect(payload.vaultToken.contractId).toBe("VAULT");
    expect(payload.vaultContractId).toBe("YIELD");
  });

  it("resets existing cache before initializing", () => {
    process.env.ZAP_ASSETS_JSON = JSON.stringify([
      { symbol: "XLM", name: "Stellar Lumens", contractId: "CDXLM1", decimals: 7 },
    ]);
    process.env.VAULT_TOKEN_CONTRACT_ID = "VAULT1";
    process.env.VAULT_CONTRACT_ID = "YIELD1";

    initializeZapSupportedAssetsCache(process.env);

    process.env.ZAP_ASSETS_JSON = JSON.stringify([
      { symbol: "USDC", name: "USD Coin", contractId: "CDUSDC", decimals: 7 },
    ]);
    process.env.VAULT_TOKEN_CONTRACT_ID = "VAULT2";
    process.env.VAULT_CONTRACT_ID = "YIELD2";

    const payload = initializeZapSupportedAssetsCache(process.env);

    expect(payload.assets).toHaveLength(1);
    expect(payload.assets[0]?.symbol).toBe("USDC");
    expect(payload.vaultToken.contractId).toBe("VAULT2");
    expect(payload.vaultContractId).toBe("YIELD2");
  });

  it("returns the cached payload", () => {
    process.env.ZAP_ASSETS_JSON = JSON.stringify([
      { symbol: "XLM", name: "Stellar Lumens", contractId: "CDXLM", decimals: 7 },
    ]);
    process.env.VAULT_TOKEN_CONTRACT_ID = "VAULT";
    process.env.VAULT_CONTRACT_ID = "YIELD";

    const payload1 = initializeZapSupportedAssetsCache(process.env);
    const payload2 = getZapSupportedAssetsPayload();

    expect(payload1).toBe(payload2);
  });
});

describe("getZapSupportedAssetsPayload", () => {
  let snapshot: Partial<Record<(typeof KEYS)[number], string | undefined>>;

  beforeEach(() => {
    snapshot = {};
    for (const k of KEYS) snapshot[k] = process.env[k];
    resetZapSupportedAssetsCache();
  });

  afterEach(() => {
    for (const k of KEYS) {
      const v = snapshot[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    resetZapSupportedAssetsCache();
  });

  it("lazy-loads from process.env when cache is empty", () => {
    process.env.ZAP_ASSETS_JSON = JSON.stringify([
      { symbol: "XLM", name: "Stellar Lumens", contractId: "CDXLM", decimals: 7 },
    ]);
    process.env.VAULT_TOKEN_CONTRACT_ID = "VAULT";
    process.env.VAULT_CONTRACT_ID = "YIELD";

    const payload = getZapSupportedAssetsPayload();

    expect(payload.assets).toHaveLength(1);
    expect(payload.assets[0]?.symbol).toBe("XLM");
    expect(payload.vaultToken.contractId).toBe("VAULT");
    expect(payload.vaultContractId).toBe("YIELD");
  });

  it("returns cached payload on subsequent calls", () => {
    process.env.ZAP_ASSETS_JSON = JSON.stringify([
      { symbol: "XLM", name: "Stellar Lumens", contractId: "CDXLM", decimals: 7 },
    ]);
    process.env.VAULT_TOKEN_CONTRACT_ID = "VAULT";
    process.env.VAULT_CONTRACT_ID = "YIELD";

    const payload1 = getZapSupportedAssetsPayload();
    const payload2 = getZapSupportedAssetsPayload();

    expect(payload1).toBe(payload2);
  });

  it("does not reflect env changes without reset", () => {
    process.env.ZAP_ASSETS_JSON = JSON.stringify([
      { symbol: "XLM", name: "Stellar Lumens", contractId: "CDXLM1", decimals: 7 },
    ]);
    process.env.VAULT_TOKEN_CONTRACT_ID = "VAULT1";
    process.env.VAULT_CONTRACT_ID = "YIELD1";

    const payload1 = getZapSupportedAssetsPayload();

    process.env.ZAP_ASSETS_JSON = JSON.stringify([
      { symbol: "USDC", name: "USD Coin", contractId: "CDUSDC", decimals: 7 },
    ]);
    process.env.VAULT_TOKEN_CONTRACT_ID = "VAULT2";
    process.env.VAULT_CONTRACT_ID = "YIELD2";

    const payload2 = getZapSupportedAssetsPayload();

    expect(payload1).toBe(payload2);
    expect(payload1.assets[0]?.symbol).toBe("XLM");
    expect(payload1.vaultToken.contractId).toBe("VAULT1");
  });

  it("reflects env changes after reset", () => {
    process.env.ZAP_ASSETS_JSON = JSON.stringify([
      { symbol: "XLM", name: "Stellar Lumens", contractId: "CDXLM1", decimals: 7 },
    ]);
    process.env.VAULT_TOKEN_CONTRACT_ID = "VAULT1";
    process.env.VAULT_CONTRACT_ID = "YIELD1";

    const payload1 = getZapSupportedAssetsPayload();

    resetZapSupportedAssetsCache();

    process.env.ZAP_ASSETS_JSON = JSON.stringify([
      { symbol: "USDC", name: "USD Coin", contractId: "CDUSDC", decimals: 7 },
    ]);
    process.env.VAULT_TOKEN_CONTRACT_ID = "VAULT2";
    process.env.VAULT_CONTRACT_ID = "YIELD2";

    const payload2 = getZapSupportedAssetsPayload();

    expect(payload1).not.toBe(payload2);
    expect(payload2.assets[0]?.symbol).toBe("USDC");
    expect(payload2.vaultToken.contractId).toBe("VAULT2");
  });
});

describe("resetZapSupportedAssetsCache", () => {
  let snapshot: Partial<Record<(typeof KEYS)[number], string | undefined>>;

  beforeEach(() => {
    snapshot = {};
    for (const k of KEYS) snapshot[k] = process.env[k];
    resetZapSupportedAssetsCache();
  });

  afterEach(() => {
    for (const k of KEYS) {
      const v = snapshot[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    resetZapSupportedAssetsCache();
  });

  it("clears the cache", () => {
    process.env.ZAP_ASSETS_JSON = JSON.stringify([
      { symbol: "XLM", name: "Stellar Lumens", contractId: "CDXLM", decimals: 7 },
    ]);
    process.env.VAULT_TOKEN_CONTRACT_ID = "VAULT";
    process.env.VAULT_CONTRACT_ID = "YIELD";

    const payload1 = getZapSupportedAssetsPayload();
    resetZapSupportedAssetsCache();
    const payload2 = getZapSupportedAssetsPayload();

    expect(payload1).not.toBe(payload2);
  });

  it("allows repeated initialization after reset", () => {
    process.env.ZAP_ASSETS_JSON = JSON.stringify([
      { symbol: "XLM", name: "Stellar Lumens", contractId: "CDXLM1", decimals: 7 },
    ]);
    process.env.VAULT_TOKEN_CONTRACT_ID = "VAULT1";
    process.env.VAULT_CONTRACT_ID = "YIELD1";

    initializeZapSupportedAssetsCache(process.env);
    resetZapSupportedAssetsCache();

    process.env.ZAP_ASSETS_JSON = JSON.stringify([
      { symbol: "USDC", name: "USD Coin", contractId: "CDUSDC", decimals: 7 },
    ]);
    process.env.VAULT_TOKEN_CONTRACT_ID = "VAULT2";
    process.env.VAULT_CONTRACT_ID = "YIELD2";

    initializeZapSupportedAssetsCache(process.env);

    const payload = getZapSupportedAssetsPayload();
    expect(payload.assets[0]?.symbol).toBe("USDC");
    expect(payload.vaultToken.contractId).toBe("VAULT2");
  });

  it("is idempotent - multiple resets have no additional effect", () => {
    process.env.ZAP_ASSETS_JSON = JSON.stringify([
      { symbol: "XLM", name: "Stellar Lumens", contractId: "CDXLM", decimals: 7 },
    ]);
    process.env.VAULT_TOKEN_CONTRACT_ID = "VAULT";
    process.env.VAULT_CONTRACT_ID = "YIELD";

    getZapSupportedAssetsPayload();
    resetZapSupportedAssetsCache();
    resetZapSupportedAssetsCache();
    resetZapSupportedAssetsCache();

    const payload = getZapSupportedAssetsPayload();
    expect(payload.assets).toHaveLength(1);
    expect(payload.assets[0]?.symbol).toBe("XLM");
  });
});

describe("cache behavior under repeated access", () => {
  let snapshot: Partial<Record<(typeof KEYS)[number], string | undefined>>;

  beforeEach(() => {
    snapshot = {};
    for (const k of KEYS) snapshot[k] = process.env[k];
    resetZapSupportedAssetsCache();
  });

  afterEach(() => {
    for (const k of KEYS) {
      const v = snapshot[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    resetZapSupportedAssetsCache();
  });

  it("returns same reference on repeated get calls", () => {
    process.env.ZAP_ASSETS_JSON = JSON.stringify([
      { symbol: "XLM", name: "Stellar Lumens", contractId: "CDXLM", decimals: 7 },
    ]);
    process.env.VAULT_TOKEN_CONTRACT_ID = "VAULT";
    process.env.VAULT_CONTRACT_ID = "YIELD";

    const references: ZapSupportedAssetsPayload[] = [];
    for (let i = 0; i < 10; i++) {
      references.push(getZapSupportedAssetsPayload());
    }

    expect(references.every((ref) => ref === references[0])).toBe(true);
  });

  it("handles repeated initialize cycles deterministically", () => {
    process.env.ZAP_ASSETS_JSON = JSON.stringify([
      { symbol: "XLM", name: "Stellar Lumens", contractId: "CDXLM", decimals: 7 },
    ]);
    process.env.VAULT_TOKEN_CONTRACT_ID = "VAULT";
    process.env.VAULT_CONTRACT_ID = "YIELD";

    const payloads: ZapSupportedAssetsPayload[] = [];
    for (let i = 0; i < 5; i++) {
      resetZapSupportedAssetsCache();
      payloads.push(initializeZapSupportedAssetsCache(process.env));
    }

    expect(payloads.every((p) => p.assets[0]?.symbol === "XLM")).toBe(true);
    expect(payloads.every((p) => p.vaultToken.contractId === "VAULT")).toBe(true);
  });

  it("maintains cache consistency across mixed initialize and get calls", () => {
    process.env.ZAP_ASSETS_JSON = JSON.stringify([
      { symbol: "XLM", name: "Stellar Lumens", contractId: "CDXLM", decimals: 7 },
    ]);
    process.env.VAULT_TOKEN_CONTRACT_ID = "VAULT";
    process.env.VAULT_CONTRACT_ID = "YIELD";

    const payload1 = initializeZapSupportedAssetsCache(process.env);
    const payload2 = getZapSupportedAssetsPayload();
    const payload3 = getZapSupportedAssetsPayload();

    expect(payload1).toBe(payload2);
    expect(payload2).toBe(payload3);
  });
});

describe("malformed cached state handling", () => {
  let snapshot: Partial<Record<(typeof KEYS)[number], string | undefined>>;

  beforeEach(() => {
    snapshot = {};
    for (const k of KEYS) snapshot[k] = process.env[k];
    resetZapSupportedAssetsCache();
  });

  afterEach(() => {
    for (const k of KEYS) {
      const v = snapshot[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    resetZapSupportedAssetsCache();
  });

  it("recovers from invalid env after reset", () => {
    process.env.ZAP_ASSETS_JSON = "invalid-json";
    process.env.VAULT_TOKEN_CONTRACT_ID = "VAULT";
    process.env.VAULT_CONTRACT_ID = "YIELD";

    expect(() => getZapSupportedAssetsPayload()).toThrow(/valid JSON/);

    resetZapSupportedAssetsCache();

    process.env.ZAP_ASSETS_JSON = JSON.stringify([
      { symbol: "XLM", name: "Stellar Lumens", contractId: "CDXLM", decimals: 7 },
    ]);

    const payload = getZapSupportedAssetsPayload();
    expect(payload.assets).toHaveLength(1);
    expect(payload.assets[0]?.symbol).toBe("XLM");
  });

  it("handles empty ZAP_ASSETS_JSON after reset", () => {
    process.env.ZAP_ASSETS_JSON = "[]";
    process.env.VAULT_TOKEN_CONTRACT_ID = "VAULT";
    process.env.VAULT_CONTRACT_ID = "YIELD";

    expect(() => getZapSupportedAssetsPayload()).toThrow(/at least one asset/);

    resetZapSupportedAssetsCache();

    delete process.env.ZAP_ASSETS_JSON;
    process.env.XLM_SAC_CONTRACT_ID = "CDXLM";

    const payload = getZapSupportedAssetsPayload();
    expect(payload.assets.some((a) => a.symbol === "XLM")).toBe(true);
  });

  it("recovers from missing required env after reset", () => {
    delete process.env.ZAP_ASSETS_JSON;
    delete process.env.VAULT_TOKEN_CONTRACT_ID;
    delete process.env.VAULT_CONTRACT_ID;

    const payload1 = getZapSupportedAssetsPayload();
    expect(payload1.vaultToken.contractId).toBe("");

    resetZapSupportedAssetsCache();

    process.env.VAULT_TOKEN_CONTRACT_ID = "VAULT";
    process.env.VAULT_CONTRACT_ID = "YIELD";

    const payload2 = getZapSupportedAssetsPayload();
    expect(payload2.vaultToken.contractId).toBe("VAULT");
    expect(payload2.vaultContractId).toBe("YIELD");
  });

  it("handles malformed asset entry after reset", () => {
    process.env.ZAP_ASSETS_JSON = JSON.stringify([
      { symbol: "XLM", name: "Stellar Lumens", contractId: "CDXLM", decimals: 7.5 },
    ]);
    process.env.VAULT_TOKEN_CONTRACT_ID = "VAULT";
    process.env.VAULT_CONTRACT_ID = "YIELD";

    expect(() => getZapSupportedAssetsPayload()).toThrow(/decimals/);

    resetZapSupportedAssetsCache();

    process.env.ZAP_ASSETS_JSON = JSON.stringify([
      { symbol: "XLM", name: "Stellar Lumens", contractId: "CDXLM", decimals: 7 },
    ]);

    const payload = getZapSupportedAssetsPayload();
    expect(payload.assets).toHaveLength(1);
    expect(payload.assets[0]?.decimals).toBe(7);
  });
});
