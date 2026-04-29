"use client";

import React from "react";
import type { ConfidenceScore } from "../../../../server/src/services/confidenceService";

const LABEL_STYLES: Record<string, string> = {
  "Very High": "bg-emerald-500/20 text-emerald-400 border-emerald-500/30",
  High:        "bg-blue-500/20    text-blue-400    border-blue-500/30",
  Medium:      "bg-yellow-500/20  text-yellow-400  border-yellow-500/30",
  Low:         "bg-orange-500/20  text-orange-400  border-orange-500/30",
  "Very Low":  "bg-red-500/20     text-red-400     border-red-500/30",
};

interface Props {
  confidence: ConfidenceScore;
  compact?: boolean;
}

/**
 * ConfidenceBadge (#277)
 *
 * Displays the AI recommendation confidence score with an uncertainty band.
 * Wording is intentionally non-committal — confidence ≠ guarantee.
 */
export function ConfidenceBadge({ confidence, compact = false }: Props) {
  const pct = Math.round(confidence.score * 100);
  const band = Math.round(confidence.uncertaintyBand * 100);
  const cls = LABEL_STYLES[confidence.label] ?? LABEL_STYLES["Medium"];

  if (compact) {
    return (
      <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-semibold ${cls}`}>
        {pct}% confidence
      </span>
    );
  }

  return (
    <div className={`rounded-xl border p-4 space-y-3 ${cls}`}>
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wider opacity-75">Confidence</span>
        <span className="text-lg font-bold">{confidence.label}</span>
      </div>

      {/* Score bar */}
      <div className="space-y-1">
        <div className="flex justify-between text-xs opacity-75">
          <span>{pct}%</span>
          <span>±{band}%</span>
        </div>
        <div className="h-2 rounded-full bg-black/20 overflow-hidden">
          <div className="h-full rounded-full bg-current opacity-70" style={{ width: `${pct}%` }} />
        </div>
        <p className="text-xs opacity-60">
          Range: {Math.max(0, pct - band)}% – {Math.min(100, pct + band)}%
        </p>
      </div>

      {/* Factor breakdown */}
      <div className="grid grid-cols-2 gap-1 text-xs opacity-75">
        {[
          ["Freshness",   confidence.factors.freshness],
          ["Agreement",   confidence.factors.providerAgreement],
          ["Liquidity",   confidence.factors.liquidityQuality],
          ["Completeness",confidence.factors.modelCompleteness],
        ].map(([label, val]) => (
          <div key={label as string} className="flex justify-between">
            <span>{label as string}</span>
            <span>{Math.round((val as number) * 100)}%</span>
          </div>
        ))}
      </div>

      {/* Caveats */}
      {confidence.caveats.length > 0 && (
        <ul className="text-xs opacity-70 space-y-0.5">
          {confidence.caveats.map((c, i) => (
            <li key={i}>• {c}</li>
          ))}
        </ul>
      )}

      <p className="text-[0.6rem] opacity-50">
        Confidence is informational only and does not constitute investment advice.
      </p>
    </div>
  );
}
