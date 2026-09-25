import { useCallback, useEffect, useState } from "react";
import { apiUrl } from "../../lib/api";
import { useWallet } from "../../context/useWallet";
import { UnwindPreviewCard } from "../../features/delta_neutral/UnwindPreviewCard";
import type { UnwindQuote } from "../../features/delta_neutral/unwindPreview";

export default function DeltaNeutralUnwind() {
  const { walletAddress, isConnected } = useWallet();
  const params = new URLSearchParams(window.location.search);
  const contractId = params.get("contractId") ?? "";
  const spotToken = params.get("spotToken") ?? "";
  const oracle = params.get("oracle") ?? "";

  const [quote, setQuote] = useState<UnwindQuote | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const loadPreview = useCallback(async () => {
    if (!isConnected || !walletAddress || !contractId || !spotToken || !oracle) return;
    setIsLoading(true);
    try {
      const url = apiUrl(`/api/strategies/delta-neutral/${contractId}/unwind-quote`);
      const qs = new URLSearchParams({ depositor: walletAddress, spotToken, oracle });
      const res = await fetch(`${url}?${qs.toString()}`);
      const data = await res.json();
      if (res.ok) setQuote(data as UnwindQuote);
    } catch (err) {
      console.error("Unwind preview failed:", err);
    } finally {
      setIsLoading(false);
    }
  }, [isConnected, walletAddress, contractId, spotToken, oracle]);

  useEffect(() => {
    void loadPreview();
  }, [loadPreview]);

  return (
    <div className="max-w-2xl mx-auto p-6 space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-white">Unwind Delta-Neutral Position</h2>
        <p className="text-gray-400 mt-1">
          Review expected unwind proceeds before signing.
        </p>
      </div>

      {!isConnected || !walletAddress ? (
        <p className="text-sm text-gray-500">Connect a wallet to preview an unwind.</p>
      ) : (
        <UnwindPreviewCard
          quote={quote}
          isLoading={isLoading}
          onConfirm={() => {
            // TODO: wire to close_position via the existing soroban.ts client
            // once contract-call plumbing for this strategy exists.
          }}
        />
      )}
    </div>
  );
}
