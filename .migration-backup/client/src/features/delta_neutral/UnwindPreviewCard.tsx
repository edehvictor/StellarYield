import React from "react";
import { AlertTriangle, Info } from "lucide-react";
import { canSubmit, formatUsdc, type UnwindQuote } from "./unwindPreview";

interface UnwindPreviewCardProps {
  quote: UnwindQuote | null;
  isLoading?: boolean;
  onConfirm: () => void;
}

const LEG_LABEL: Record<UnwindQuote["legs"][number]["leg"], string> = {
  spot: "Spot (long leg)",
  perp: "Perp short (hedge leg)",
};

export const UnwindPreviewCard: React.FC<UnwindPreviewCardProps> = ({
  quote,
  isLoading = false,
  onConfirm,
}) => {
  const executable = canSubmit(quote);

  return (
    <div className="glass-panel p-6 space-y-4 border border-white/10">
      <h3 className="text-lg font-bold flex items-center gap-2">
        <Info size={20} className="text-[#6C5DD3]" />
        Unwind Preview
      </h3>

      {isLoading && <p className="text-sm text-gray-400">Loading preview…</p>}

      {!isLoading && !quote && (
        <p className="text-sm text-gray-400">No preview available yet.</p>
      )}

      {!isLoading && quote && (
        <>
          <div className="space-y-2">
            {quote.legs.map((leg) => (
              <div
                key={leg.leg}
                className="flex justify-between items-center p-3 bg-black/20 rounded-lg"
              >
                <span className="text-sm text-gray-400">{LEG_LABEL[leg.leg]}</span>
                {leg.status === "quoted" ? (
                  <span className="font-medium">{formatUsdc(leg.expectedOutputUsdc)}</span>
                ) : (
                  <span className="text-sm text-red-400">
                    Unavailable — {leg.reason ?? "could not be quoted"}
                  </span>
                )}
              </div>
            ))}
          </div>

          {quote.totalExpectedUsdc !== undefined && (
            <div className="flex justify-between items-center p-3 bg-black/30 rounded-lg">
              <span className="text-sm text-gray-400">Total expected</span>
              <span className="text-xl font-bold">{formatUsdc(quote.totalExpectedUsdc)}</span>
            </div>
          )}

          {quote.riskNotes.length > 0 && (
            <ul className="space-y-1 text-xs text-gray-400 list-disc list-inside">
              {quote.riskNotes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          )}

          {!executable && (
            <div className="flex items-start gap-3 p-3 bg-yellow-500/10 border border-yellow-500/30 rounded-lg">
              <AlertTriangle className="w-5 h-5 text-yellow-500 shrink-0 mt-0.5" />
              <p className="text-xs text-yellow-200/80">
                This unwind cannot proceed to execution — one or more legs
                could not be safely quoted. Review the reasons above before
                retrying.
              </p>
            </div>
          )}

          <button
            type="button"
            onClick={onConfirm}
            disabled={!executable}
            className="w-full px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            Close Position
          </button>
        </>
      )}
    </div>
  );
};
