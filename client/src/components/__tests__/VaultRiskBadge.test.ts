/**
 * VaultRiskBadge tests (#1189)
 *
 * Verifies that the same risk score/label renders the same badge in both
 * dashboard and detail views, and that unknown scores use a neutral state.
 */
import { describe, it, expect } from "vitest";
import {
  scoreToRiskLevel,
  normalizeRiskLabel,
  getVaultRiskBadgeConfig,
  VAULT_RISK_BADGE_CONFIG,
  type VaultRiskLevel,
} from "../common/VaultRiskBadge";

describe("VaultRiskBadge — scoreToRiskLevel", () => {
  it("maps 0 to Low", () => expect(scoreToRiskLevel(0)).toBe("Low"));
  it("maps 3 to Low", () => expect(scoreToRiskLevel(3)).toBe("Low"));
  it("maps 4 to Medium", () => expect(scoreToRiskLevel(4)).toBe("Medium"));
  it("maps 6 to Medium", () => expect(scoreToRiskLevel(6)).toBe("Medium"));
  it("maps 7 to High", () => expect(scoreToRiskLevel(7)).toBe("High"));
  it("maps 10 to High", () => expect(scoreToRiskLevel(10)).toBe("High"));

  it("returns Unknown for NaN", () => expect(scoreToRiskLevel(NaN)).toBe("Unknown"));
  it("returns Unknown for negative score", () => expect(scoreToRiskLevel(-1)).toBe("Unknown"));
  it("returns Unknown for score > 10", () => expect(scoreToRiskLevel(11)).toBe("Unknown"));
  it("returns Unknown for non-numeric string", () => expect(scoreToRiskLevel("abc")).toBe("Unknown"));
  it("parses numeric string", () => expect(scoreToRiskLevel("5")).toBe("Medium"));
});

describe("VaultRiskBadge — normalizeRiskLabel", () => {
  it("returns Low for 'Low'", () => expect(normalizeRiskLabel("Low")).toBe("Low"));
  it("returns Medium for 'Medium'", () => expect(normalizeRiskLabel("Medium")).toBe("Medium"));
  it("returns High for 'High'", () => expect(normalizeRiskLabel("High")).toBe("High"));

  it("returns Unknown for unrecognised string", () => expect(normalizeRiskLabel("moderate")).toBe("Unknown"));
  it("returns Unknown for empty string", () => expect(normalizeRiskLabel("")).toBe("Unknown"));
  it("returns Unknown for null", () => expect(normalizeRiskLabel(null)).toBe("Unknown"));
  it("returns Unknown for undefined", () => expect(normalizeRiskLabel(undefined)).toBe("Unknown"));
  it("returns Unknown for number", () => expect(normalizeRiskLabel(5)).toBe("Unknown"));
});

describe("VaultRiskBadge — getVaultRiskBadgeConfig", () => {
  const levels: VaultRiskLevel[] = ["Low", "Medium", "High", "Unknown"];

  it.each(levels)("config for %s has all required fields", (level) => {
    const config = getVaultRiskBadgeConfig(level);
    expect(config.label).toBeTruthy();
    expect(config.color).toBeTruthy();
    expect(config.bg).toBeTruthy();
    expect(config.border).toBeTruthy();
    expect(config.explanation).toBeTruthy();
  });

  it("Low and High have different colors — not the same badge for different risk bands", () => {
    expect(getVaultRiskBadgeConfig("Low").color).not.toBe(
      getVaultRiskBadgeConfig("High").color,
    );
  });

  it("Unknown uses neutral colors (gray)", () => {
    const config = getVaultRiskBadgeConfig("Unknown");
    expect(config.color).toContain("gray");
    expect(config.bg).toContain("gray");
  });
});

describe("VaultRiskBadge — config stability (same score → same badge in all views)", () => {
  it("score 2 always renders Low regardless of source", () => {
    expect(scoreToRiskLevel(2)).toBe("Low");
    expect(VAULT_RISK_BADGE_CONFIG["Low"].label).toBe("Low");
  });

  it("score 5 always renders Medium regardless of source", () => {
    expect(scoreToRiskLevel(5)).toBe("Medium");
    expect(VAULT_RISK_BADGE_CONFIG["Medium"].label).toBe("Medium");
  });

  it("score 8 always renders High regardless of source", () => {
    expect(scoreToRiskLevel(8)).toBe("High");
    expect(VAULT_RISK_BADGE_CONFIG["High"].label).toBe("High");
  });
});
