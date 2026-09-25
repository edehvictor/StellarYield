import { useState } from "react";
import BasketRebalancePreviewPanel from "../../features/stablecoin_basket/BasketRebalancePreviewPanel";
import {
  isTargetWeightSumValid,
  hasUnavailableData,
  type BasketRebalancePreview,
} from "../../features/stablecoin_basket/basketRebalancePreview";

export default function StablecoinBasketRebalance() {
  const contractId =
    new URLSearchParams(window.location.search).get("contractId") ?? "";
  const [preview, setPreview] = useState<BasketRebalancePreview | null>(null);

  const canSubmit =
    !!preview && !hasUnavailableData(preview) && isTargetWeightSumValid(preview.legs);

  return (
    <div className="max-w-3xl mx-auto p-6 space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-white">Stablecoin Basket Rebalance</h2>
        <p className="text-gray-400 mt-1">
          Review how basket weights will change before submitting a rebalance.
        </p>
      </div>

      {!contractId ? (
        <p className="text-sm text-gray-500">
          Add a <code>?contractId=</code> query param to preview a specific basket.
        </p>
      ) : (
        <BasketRebalancePreviewPanel contractId={contractId} onPreviewChange={setPreview} />
      )}

      <button
        type="button"
        disabled={!canSubmit}
        title={
          canSubmit
            ? undefined
            : "Run a preview and resolve any weight-sum or availability issues first"
        }
        className="w-full px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
      >
        Confirm Rebalance
      </button>
      {/* TODO: no on-chain execute flow exists yet for this strategy — this
          button is a stub gated on a valid preview until that flow lands. */}
    </div>
  );
}
