/**
 * VaultRiskBadge (#1189)
 *
 * Single source of truth for vault risk badge labels, colors, and score
 * boundaries. Import this component and the helper functions wherever a
 * risk badge is shown — dashboard card, vault detail, table row — so the
 * same risk score always renders the same badge.
 *
 * Risk bands:
 *   score 0–3  → Low
 *   score 4–6  → Medium
 *   score 7–10 → High
 *   unknown    → Neutral (unknown / data not available)
 */
import React from "react";
import { Info } from "lucide-react";
import type { RiskLevel } from "../../config/riskConfig";
import { RISK_EXPLANATIONS } from "../../config/riskConfig";

// ── Types ────────────────────────────────────────────────────────────────────

export type VaultRiskLevel = RiskLevel | "Unknown";

export interface VaultRiskBadgeConfig {
  label: string;
  color: string;
  bg: string;
  border: string;
  explanation: string;
}

// ── Shared config (extends riskConfig for the "Unknown" neutral band) ────────

export const VAULT_RISK_BADGE_CONFIG: Record<VaultRiskLevel, VaultRiskBadgeConfig> = {
  Low: {
    label: "Low",
    color: RISK_EXPLANATIONS.Low.color,
    bg: RISK_EXPLANATIONS.Low.bg,
    border: RISK_EXPLANATIONS.Low.border,
    explanation: RISK_EXPLANATIONS.Low.explanation,
  },
  Medium: {
    label: "Medium",
    color: RISK_EXPLANATIONS.Medium.color,
    bg: RISK_EXPLANATIONS.Medium.bg,
    border: RISK_EXPLANATIONS.Medium.border,
    explanation: RISK_EXPLANATIONS.Medium.explanation,
  },
  High: {
    label: "High",
    color: RISK_EXPLANATIONS.High.color,
    bg: RISK_EXPLANATIONS.High.bg,
    border: RISK_EXPLANATIONS.High.border,
    explanation: RISK_EXPLANATIONS.High.explanation,
  },
  Unknown: {
    label: "Unknown",
    color: "text-gray-400",
    bg: "bg-gray-500/15",
    border: "border-gray-500/30",
    explanation: "Risk data is not available for this vault.",
  },
};

// ── Score-to-level helper ────────────────────────────────────────────────────

/**
 * Map a numeric risk score (0–10) to a `VaultRiskLevel`.
 * Scores outside the 0–10 range or NaN resolve to "Unknown".
 */
export function scoreToRiskLevel(score: unknown): VaultRiskLevel {
  const n = typeof score === "number" ? score : Number(score);
  if (!Number.isFinite(n) || n < 0 || n > 10) return "Unknown";
  if (n <= 3) return "Low";
  if (n <= 6) return "Medium";
  return "High";
}

/**
 * Normalize a free-text risk string (e.g. from the API) to a VaultRiskLevel.
 * Falls back to "Unknown" for any unrecognised value.
 */
export function normalizeRiskLabel(value: unknown): VaultRiskLevel {
  if (typeof value !== "string") return "Unknown";
  const v = value.trim();
  if (v === "Low" || v === "Medium" || v === "High") return v;
  return "Unknown";
}

/**
 * Retrieve the badge config for a given level.
 */
export function getVaultRiskBadgeConfig(level: VaultRiskLevel): VaultRiskBadgeConfig {
  return VAULT_RISK_BADGE_CONFIG[level];
}

// ── Component ────────────────────────────────────────────────────────────────

export interface VaultRiskBadgeProps {
  /** Accepts a RiskLevel string, a numeric score, or raw API string. */
  risk: string | number | null | undefined;
  /** Stable ID suffix for aria-describedby — e.g. the vault slug or row key. */
  id?: string;
  /** Additional CSS classes on the badge <span>. */
  className?: string;
}

/**
 * Renders a consistent risk badge with accessible tooltip.
 *
 * Usage:
 *   <VaultRiskBadge risk={entry.risk} id="usdc" />
 *   <VaultRiskBadge risk={7.2} id="usdc" />   // numeric score
 */
export function VaultRiskBadge({ risk, id = "vault", className = "" }: VaultRiskBadgeProps) {
  const level: VaultRiskLevel =
    typeof risk === "number"
      ? scoreToRiskLevel(risk)
      : normalizeRiskLabel(risk);

  const config = getVaultRiskBadgeConfig(level);
  const tooltipId = `vault-risk-tip-${id}`;

  return (
    <button
      type="button"
      className="group/risk relative flex cursor-help outline-none"
      aria-describedby={tooltipId}
      aria-label={`Vault risk: ${config.label}. ${config.explanation}`}
    >
      <span
        className={`${config.bg} ${config.color} ${config.border} border px-2 py-0.5 rounded-lg text-[10px] font-bold uppercase tracking-wider flex items-center gap-1 ${className}`}
      >
        {config.label} <Info size={10} aria-hidden="true" />
      </span>
      <span
        id={tooltipId}
        role="tooltip"
        className="absolute hidden group-hover/risk:block group-focus-within/risk:block bottom-full mb-2 right-0 w-48 p-2 bg-[#1A1A24] border border-white/10 rounded-lg text-xs leading-relaxed text-gray-300 shadow-xl z-10 pointer-events-none"
      >
        {config.explanation}
      </span>
    </button>
  );
}

export default VaultRiskBadge;
