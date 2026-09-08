import {
  shouldSuppressAlert,
  recommendAlertThreshold,
  normalizeAlertThresholdInputs,
  saveAlertThresholdRecommendation,
  getAlertThresholdRecommendation,
  getAlertThresholdRecommendationHistory,
  resetAlertThresholdRecommendationStore,
  ALERT_THRESHOLD_REASON_DESCRIPTIONS,
  type AlertThresholdRecommendationInput,
} from "../alertsPreferenceRules";
import {
  recordPreferenceChange,
  getPreferenceAuditHistory,
  getAuditEntryById,
  findRevertTarget,
  resetAuditStore,
  getAuditEntryCount,
} from "../alertPreferenceAuditService";
import {
  updateAlertPreferences,
  getAlertPreferences,
  revertAlertPreferences,
  resetAlertPreferencesStore,
} from "../alertsService";

describe("alert preference suppression rules", () => {
  const prefs = {
    channel: "email" as const,
    cooldownMinutes: 60,
    severityThreshold: 5,
    quietHoursStart: 23,
    quietHoursEnd: 6,
  };

  it("suppresses during quiet hours", () => {
    const now = new Date("2026-05-26T23:30:00Z");
    expect(shouldSuppressAlert(now, undefined, prefs)).toBe(true);
  });

  it("suppresses while cooldown is active", () => {
    const now = new Date("2026-05-26T12:30:00Z");
    const previous = new Date("2026-05-26T12:00:00Z").getTime();
    expect(shouldSuppressAlert(now, previous, prefs)).toBe(true);
  });

  it("allows alerts outside quiet hours and after cooldown", () => {
    const now = new Date("2026-05-26T14:30:00Z");
    const previous = new Date("2026-05-26T12:00:00Z").getTime();
    expect(shouldSuppressAlert(now, previous, prefs)).toBe(false);
  });
});

describe("Deterministic Alert Threshold Recommendations", () => {
  beforeEach(() => {
    resetAlertThresholdRecommendationStore();
  });

  describe("Determinism across repeated runs", () => {
    it("should produce identical alert threshold recommendation for 100 identical runs", () => {
      const input: AlertThresholdRecommendationInput = {
        walletAddress: "GABC123",
        vaultId: "usdc-vault-1",
        historicalVolatility: 65.5,
        triggerFrequencyPerHour: 4.2,
        noiseIndex: 0.6,
        apyDispersion: 2.5,
        userQuietHoursSpan: 8,
      };

      const baseline = recommendAlertThreshold(input);

      for (let i = 0; i < 100; i++) {
        const current = recommendAlertThreshold(input);
        expect(current.recommendedSeverityThreshold).toBe(baseline.recommendedSeverityThreshold);
        expect(current.recommendedCooldownMinutes).toBe(baseline.recommendedCooldownMinutes);
        expect(current.primaryReasonCode).toBe(baseline.primaryReasonCode);
        expect(current.reasonCodes).toEqual(baseline.reasonCodes);
        expect(current.reason).toBe(baseline.reason);
      }
    });

    it("should produce baseline defaults under normal conditions", () => {
      const normalInput: AlertThresholdRecommendationInput = {
        historicalVolatility: 30,
        triggerFrequencyPerHour: 1.0,
        noiseIndex: 0.2,
        apyDispersion: 1.0,
      };

      const result = recommendAlertThreshold(normalInput);
      expect(result.recommendedSeverityThreshold).toBe(5.0);
      expect(result.recommendedCooldownMinutes).toBe(60);
      expect(result.primaryReasonCode).toBe("BASELINE_DEFAULT");
      expect(result.reasonCodes).toEqual(["BASELINE_DEFAULT"]);
    });
  });

  describe("Jittery input normalization", () => {
    it("should normalize floating point jitter to produce identical output", () => {
      const cleanInput: AlertThresholdRecommendationInput = {
        historicalVolatility: 70.0,
        triggerFrequencyPerHour: 3.0,
        noiseIndex: 0.4,
      };

      const jitteryInput: AlertThresholdRecommendationInput = {
        historicalVolatility: 70.00000000000001,
        triggerFrequencyPerHour: 3.0000000000000004,
        noiseIndex: 0.4000000000000001,
      };

      const cleanRec = recommendAlertThreshold(cleanInput);
      const jitteryRec = recommendAlertThreshold(jitteryInput);

      expect(jitteryRec.recommendedSeverityThreshold).toBe(cleanRec.recommendedSeverityThreshold);
      expect(jitteryRec.recommendedCooldownMinutes).toBe(cleanRec.recommendedCooldownMinutes);
      expect(jitteryRec.primaryReasonCode).toBe(cleanRec.primaryReasonCode);
      expect(jitteryRec.reasonCodes).toEqual(cleanRec.reasonCodes);
    });
  });

  describe("Boundary conditions and clamping", () => {
    it("should clamp out-of-range inputs safely", () => {
      const extremeInput: Partial<AlertThresholdRecommendationInput> = {
        historicalVolatility: 200,
        triggerFrequencyPerHour: -5,
        noiseIndex: 10,
        apyDispersion: -1,
        userQuietHoursSpan: 50,
      };

      const normalized = normalizeAlertThresholdInputs(extremeInput);
      expect(normalized.historicalVolatility).toBe(100);
      expect(normalized.triggerFrequencyPerHour).toBe(0);
      expect(normalized.noiseIndex).toBe(1);
      expect(normalized.apyDispersion).toBe(0);
      expect(normalized.userQuietHoursSpan).toBe(24);
    });

    it("should handle empty or partial inputs gracefully", () => {
      const rec = recommendAlertThreshold({});
      expect(rec.recommendedSeverityThreshold).toBeGreaterThanOrEqual(1.0);
      expect(rec.recommendedCooldownMinutes).toBeGreaterThanOrEqual(15);
      expect(rec.primaryReasonCode).toBeDefined();
    });

    it("should enforce minimum severity floor and maximum ceiling", () => {
      const lowRec = recommendAlertThreshold(
        { historicalVolatility: 0 },
        { defaultSeverityThreshold: 1.0, minSeverityThreshold: 1.0 },
      );
      expect(lowRec.recommendedSeverityThreshold).toBe(1.0);
      expect(lowRec.reasonCodes).toContain("MIN_SEVERITY_FLOOR");

      const highRec = recommendAlertThreshold(
        { historicalVolatility: 100, noiseIndex: 1.0 },
        { defaultSeverityThreshold: 20.0, maxSeverityThreshold: 22.0 },
      );
      expect(highRec.recommendedSeverityThreshold).toBe(22.0);
      expect(highRec.reasonCodes).toContain("MAX_SEVERITY_CEILING");
    });
  });

  describe("Reason codes and explanatory descriptions", () => {
    it("should assign HIGH_VOLATILITY_EXPANSION when volatility > 50", () => {
      const rec = recommendAlertThreshold({ historicalVolatility: 75 });
      expect(rec.reasonCodes).toContain("HIGH_VOLATILITY_EXPANSION");
      expect(rec.reason).toContain("High market volatility");
    });

    it("should assign LOW_VOLATILITY_TIGHTENING when volatility < 15", () => {
      const rec = recommendAlertThreshold({ historicalVolatility: 5 });
      expect(rec.reasonCodes).toContain("LOW_VOLATILITY_TIGHTENING");
      expect(rec.reason).toContain("Low volatility environment");
    });

    it("should assign BURST_TRIGGER_SUPPRESSION when frequency >= 3", () => {
      const rec = recommendAlertThreshold({ triggerFrequencyPerHour: 5 });
      expect(rec.reasonCodes).toContain("BURST_TRIGGER_SUPPRESSION");
      expect(rec.reason).toContain("Frequent trigger burst history");
    });

    it("should assign HIGH_NOISE_DAMPENING when noiseIndex > 0.5", () => {
      const rec = recommendAlertThreshold({ noiseIndex: 0.8 });
      expect(rec.reasonCodes).toContain("HIGH_NOISE_DAMPENING");
      expect(rec.reason).toContain("Noise dampening applied");
    });

    it("should assign QUIET_HOURS_BUFFER when quiet hours span >= 6", () => {
      const rec = recommendAlertThreshold({ userQuietHoursSpan: 8 });
      expect(rec.reasonCodes).toContain("QUIET_HOURS_BUFFER");
    });

    it("should have valid descriptions for all reason codes", () => {
      const rec = recommendAlertThreshold({ historicalVolatility: 80, triggerFrequencyPerHour: 5 });
      for (const code of rec.reasonCodes) {
        expect(ALERT_THRESHOLD_REASON_DESCRIPTIONS[code]).toBeDefined();
        expect(typeof ALERT_THRESHOLD_REASON_DESCRIPTIONS[code]).toBe("string");
      }
    });
  });

  describe("Persistence & History Store", () => {
    it("should persist and retrieve recommendations by wallet and vault", () => {
      const wallet = "GABCXYZ123";
      const vault = "xlm-vault";

      const rec = recommendAlertThreshold({
        walletAddress: wallet,
        vaultId: vault,
        historicalVolatility: 60,
      });

      const retrieved = getAlertThresholdRecommendation(wallet, vault);
      expect(retrieved).toBeDefined();
      expect(retrieved?.recommendedSeverityThreshold).toBe(rec.recommendedSeverityThreshold);
      expect(retrieved?.primaryReasonCode).toBe(rec.primaryReasonCode);

      const history = getAlertThresholdRecommendationHistory(wallet, vault);
      expect(history.length).toBe(1);
    });

    it("should clear history on reset", () => {
      const wallet = "GABCXYZ123";
      const vault = "xlm-vault";

      recommendAlertThreshold({ walletAddress: wallet, vaultId: vault, historicalVolatility: 60 });
      resetAlertThresholdRecommendationStore();

      expect(getAlertThresholdRecommendation(wallet, vault)).toBeUndefined();
      expect(getAlertThresholdRecommendationHistory(wallet, vault)).toEqual([]);
    });
  });
});

describe("Alert Preference Audit Trail", () => {
  beforeEach(() => {
    resetAuditStore();
  });

  const samplePrefs = {
    channel: "email" as const,
    cooldownMinutes: 60,
    severityThreshold: 5,
    quietHoursStart: 23,
    quietHoursEnd: 6,
  };

  describe("recordPreferenceChange", () => {
    it("should record an audit entry with all required fields", () => {
      const entry = recordPreferenceChange({
        walletAddress: "GWALLET1",
        vaultId: "Blend",
        actor: "GWALLET1",
        source: "api",
        before: null,
        after: samplePrefs,
        reason: "Initial setup",
      });

      expect(entry.id).toMatch(/^audit-\d+$/);
      expect(entry.walletAddress).toBe("GWALLET1");
      expect(entry.vaultId).toBe("Blend");
      expect(entry.actor).toBe("GWALLET1");
      expect(entry.source).toBe("api");
      expect(entry.before).toBeNull();
      expect(entry.after).toEqual(samplePrefs);
      expect(entry.reason).toBe("Initial setup");
      expect(typeof entry.timestamp).toBe("string");
      expect(new Date(entry.timestamp).toISOString()).toBe(entry.timestamp);
    });

    it('should record entry with "before" snapshot on update', () => {
      const updatedPrefs = { ...samplePrefs, cooldownMinutes: 120 };
      const entry = recordPreferenceChange({
        walletAddress: "GWALLET1",
        vaultId: "Blend",
        actor: "GWALLET1",
        source: "api",
        before: samplePrefs,
        after: updatedPrefs,
      });

      expect(entry.before).toEqual(samplePrefs);
      expect(entry.after.cooldownMinutes).toBe(120);
    });

    it("should use unique IDs for each entry", () => {
      const entry1 = recordPreferenceChange({
        walletAddress: "GWALLET1",
        vaultId: "Blend",
        actor: "GWALLET1",
        source: "api",
        before: null,
        after: samplePrefs,
      });
      const entry2 = recordPreferenceChange({
        walletAddress: "GWALLET1",
        vaultId: "Blend",
        actor: "GWALLET1",
        source: "api",
        before: samplePrefs,
        after: samplePrefs,
      });

      expect(entry1.id).not.toBe(entry2.id);
    });

    it("should support all audit sources", () => {
      for (const source of ["api", "system", "admin", "revert"] as const) {
        const entry = recordPreferenceChange({
          walletAddress: "GWALLET1",
          vaultId: "Blend",
          actor: "actor",
          source,
          before: null,
          after: samplePrefs,
        });
        expect(entry.source).toBe(source);
      }
    });
  });

  describe("getPreferenceAuditHistory", () => {
    it("should return empty array when no entries exist", () => {
      const history = getPreferenceAuditHistory("GWALLET1", "Blend");
      expect(history).toEqual([]);
    });

    it("should return entries in newest-first order", () => {
      const prefs1 = { ...samplePrefs, cooldownMinutes: 30 };
      const prefs2 = { ...samplePrefs, cooldownMinutes: 90 };

      recordPreferenceChange({
        walletAddress: "GWALLET1",
        vaultId: "Blend",
        actor: "GWALLET1",
        source: "api",
        before: null,
        after: prefs1,
      });
      recordPreferenceChange({
        walletAddress: "GWALLET1",
        vaultId: "Blend",
        actor: "GWALLET1",
        source: "api",
        before: prefs1,
        after: prefs2,
      });

      const history = getPreferenceAuditHistory("GWALLET1", "Blend");
      expect(history).toHaveLength(2);
      expect(history[0].after.cooldownMinutes).toBe(90);
      expect(history[1].after.cooldownMinutes).toBe(30);
    });

    it("should isolate histories by wallet+vault pair", () => {
      recordPreferenceChange({
        walletAddress: "GWALLET1",
        vaultId: "Blend",
        actor: "GWALLET1",
        source: "api",
        before: null,
        after: samplePrefs,
      });
      recordPreferenceChange({
        walletAddress: "GWALLET2",
        vaultId: "Blend",
        actor: "GWALLET2",
        source: "api",
        before: null,
        after: samplePrefs,
      });

      expect(getPreferenceAuditHistory("GWALLET1", "Blend")).toHaveLength(1);
      expect(getPreferenceAuditHistory("GWALLET2", "Blend")).toHaveLength(1);
      expect(getPreferenceAuditHistory("GWALLET1", "Soroswap")).toHaveLength(0);
    });
  });

  describe("getAuditEntryById", () => {
    it("should find an entry by its ID", () => {
      const entry = recordPreferenceChange({
        walletAddress: "GWALLET1",
        vaultId: "Blend",
        actor: "GWALLET1",
        source: "api",
        before: null,
        after: samplePrefs,
      });

      const found = getAuditEntryById("GWALLET1", "Blend", entry.id);
      expect(found).toBeDefined();
      expect(found?.id).toBe(entry.id);
    });

    it("should return undefined for non-existent entry", () => {
      const found = getAuditEntryById("GWALLET1", "Blend", "audit-9999");
      expect(found).toBeUndefined();
    });
  });

  describe("findRevertTarget", () => {
    it("should return undefined when fewer than 2 entries exist", () => {
      recordPreferenceChange({
        walletAddress: "GWALLET1",
        vaultId: "Blend",
        actor: "GWALLET1",
        source: "api",
        before: null,
        after: samplePrefs,
      });

      expect(findRevertTarget("GWALLET1", "Blend")).toBeUndefined();
    });

    it("should return the second entry as the revert target", () => {
      const prefs1 = { ...samplePrefs, cooldownMinutes: 30 };
      const prefs2 = { ...samplePrefs, cooldownMinutes: 90 };

      recordPreferenceChange({
        walletAddress: "GWALLET1",
        vaultId: "Blend",
        actor: "GWALLET1",
        source: "api",
        before: null,
        after: prefs1,
      });
      recordPreferenceChange({
        walletAddress: "GWALLET1",
        vaultId: "Blend",
        actor: "GWALLET1",
        source: "api",
        before: prefs1,
        after: prefs2,
      });

      const target = findRevertTarget("GWALLET1", "Blend");
      expect(target).toBeDefined();
      expect(target?.after.cooldownMinutes).toBe(30);
    });
  });

  describe("resetAuditStore", () => {
    it("should clear all entries and reset ID counter", () => {
      recordPreferenceChange({
        walletAddress: "GWALLET1",
        vaultId: "Blend",
        actor: "GWALLET1",
        source: "api",
        before: null,
        after: samplePrefs,
      });

      resetAuditStore();
      expect(getPreferenceAuditHistory("GWALLET1", "Blend")).toEqual([]);
    });
  });

  describe("getAuditEntryCount", () => {
    it("should return 0 for empty store", () => {
      expect(getAuditEntryCount("GWALLET1", "Blend")).toBe(0);
    });

    it("should return correct count after entries are added", () => {
      recordPreferenceChange({
        walletAddress: "GWALLET1",
        vaultId: "Blend",
        actor: "GWALLET1",
        source: "api",
        before: null,
        after: samplePrefs,
      });
      recordPreferenceChange({
        walletAddress: "GWALLET1",
        vaultId: "Blend",
        actor: "GWALLET1",
        source: "api",
        before: samplePrefs,
        after: samplePrefs,
      });

      expect(getAuditEntryCount("GWALLET1", "Blend")).toBe(2);
    });
  });
});

describe("Preference Update, Revert, and Audit Integration", () => {
  const wallet = "GWALLET_AUDIT";
  const vault = "usdc-vault";
  const samplePrefs = {
    channel: "email" as const,
    cooldownMinutes: 60,
    severityThreshold: 5,
    quietHoursStart: 23,
    quietHoursEnd: 6,
  };

  beforeEach(() => {
    resetAuditStore();
    resetAlertPreferencesStore();
  });

  describe("updateAlertPreferences", () => {
    it("should store preferences and create an audit entry", () => {
      const result = updateAlertPreferences(wallet, vault, samplePrefs, {
        actor: wallet,
        source: "api",
        reason: "Initial setup",
      });

      expect(result.preferences).toEqual(samplePrefs);
      expect(result.auditEntry.before).toBeNull();
      expect(result.auditEntry.after).toEqual(samplePrefs);
      expect(result.auditEntry.source).toBe("api");
      expect(result.auditEntry.reason).toBe("Initial setup");
    });

    it("should record previous state when updating existing preferences", () => {
      updateAlertPreferences(wallet, vault, samplePrefs, {
        actor: wallet,
        source: "api",
      });

      const updated = { ...samplePrefs, cooldownMinutes: 120 };
      const result = updateAlertPreferences(wallet, vault, updated, {
        actor: wallet,
        source: "api",
        reason: "Increased cooldown",
      });

      expect(result.auditEntry.before).toEqual(samplePrefs);
      expect(result.auditEntry.after.cooldownMinutes).toBe(120);
    });

    it('should default source to "api" and actor to walletAddress', () => {
      const result = updateAlertPreferences(wallet, vault, samplePrefs);
      expect(result.auditEntry.source).toBe("api");
      expect(result.auditEntry.actor).toBe(wallet);
    });

    it("should allow overriding actor and source", () => {
      const result = updateAlertPreferences(wallet, vault, samplePrefs, {
        actor: "system",
        source: "system",
      });
      expect(result.auditEntry.actor).toBe("system");
      expect(result.auditEntry.source).toBe("system");
    });
  });

  describe("getAlertPreferences", () => {
    it("should return undefined when no preferences exist", () => {
      expect(getAlertPreferences(wallet, vault)).toBeUndefined();
    });

    it("should return stored preferences after update", () => {
      updateAlertPreferences(wallet, vault, samplePrefs);
      expect(getAlertPreferences(wallet, vault)).toEqual(samplePrefs);
    });
  });

  describe("revertAlertPreferences", () => {
    it("should revert to the previous preference snapshot", () => {
      updateAlertPreferences(wallet, vault, samplePrefs);
      const updated = { ...samplePrefs, cooldownMinutes: 180 };
      updateAlertPreferences(wallet, vault, updated);

      const result = revertAlertPreferences(wallet, vault);
      expect(result.preferences.cooldownMinutes).toBe(60);
      expect(result.auditEntry.source).toBe("revert");
    });

    it("should record the revert in audit history", () => {
      updateAlertPreferences(wallet, vault, samplePrefs);
      updateAlertPreferences(wallet, vault, { ...samplePrefs, cooldownMinutes: 180 });
      revertAlertPreferences(wallet, vault);

      const history = getPreferenceAuditHistory(wallet, vault);
      // Newest first: revert, update, initial
      expect(history).toHaveLength(3);
      expect(history[0].source).toBe("revert");
      expect(history[0].after.cooldownMinutes).toBe(60);
      expect(history[0].before?.cooldownMinutes).toBe(180);
    });

    it("should revert to a specific audit entry by ID", () => {
      updateAlertPreferences(wallet, vault, samplePrefs);
      const entry2 = updateAlertPreferences(
        wallet,
        vault,
        { ...samplePrefs, cooldownMinutes: 120 },
      );
      updateAlertPreferences(wallet, vault, { ...samplePrefs, cooldownMinutes: 180 });

      const result = revertAlertPreferences(wallet, vault, entry2.auditEntry.id);
      expect(result.preferences.cooldownMinutes).toBe(120);
    });

    it("should throw when no previous snapshot exists to revert to", () => {
      updateAlertPreferences(wallet, vault, samplePrefs);
      // Only one entry — no previous to revert to
      expect(() => revertAlertPreferences(wallet, vault)).toThrow(
        "No previous preference snapshot to revert to",
      );
    });

    it("should throw when the target entry ID does not exist", () => {
      updateAlertPreferences(wallet, vault, samplePrefs);
      expect(() => revertAlertPreferences(wallet, vault, "audit-nonexistent")).toThrow(
        "Audit entry audit-nonexistent not found",
      );
    });

    it("should allow multiple consecutive reverts creating a full audit trail", () => {
      const prefs1 = { ...samplePrefs, cooldownMinutes: 30 };
      const prefs2 = { ...samplePrefs, cooldownMinutes: 90 };

      updateAlertPreferences(wallet, vault, prefs1);
      updateAlertPreferences(wallet, vault, prefs2);
      revertAlertPreferences(wallet, vault); // back to prefs1
      revertAlertPreferences(wallet, vault); // back to prefs2 (before prefs1)

      const history = getPreferenceAuditHistory(wallet, vault);
      expect(history).toHaveLength(4);
      // Newest first: revert(prefs2), revert(prefs1), update(prefs2), initial(prefs1)
      expect(history[0].source).toBe("revert");
      expect(history[0].after.cooldownMinutes).toBe(90);
      expect(history[1].source).toBe("revert");
      expect(history[1].after.cooldownMinutes).toBe(30);
    });
  });
});
