import { AlertTriangle, Plug, RefreshCw, Unplug } from "lucide-react";
import { useMemo } from "react";
import { useWallet } from "../context/useWallet";

const STALE_MINUTES = 30;

function minutesSince(iso: string | null): number | null {
  if (!iso) return null;
  const parsed = new Date(iso).getTime();
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, Math.floor((Date.now() - parsed) / 60000));
}

export default function WalletSessionReview() {
  const {
    isConnected,
    walletAddress,
    providerLabel,
    providerId,
    network,
    connectedAt,
    lastActivityAt,
    disconnectWallet,
    connectWallet,
  } = useWallet();

  const sessionAgeMinutes = minutesSince(connectedAt);
  const lastActivityMinutes = minutesSince(lastActivityAt);
  const isStale = (lastActivityMinutes ?? Number.MAX_SAFE_INTEGER) > STALE_MINUTES;
  const warnings = useMemo(() => {
    const items: string[] = [];
    if (!providerId) items.push("Missing wallet adapter metadata.");
    if (!network) items.push("Missing wallet network state.");
    if (isStale) items.push("Session appears stale based on last activity.");
    return items;
  }, [providerId, network, isStale]);

  if (!isConnected) {
    return (
      <div className="glass-panel p-6 space-y-3">
        <h2 className="text-2xl font-bold">Wallet Session Review</h2>
        <p className="text-gray-400">No active wallet session.</p>
        <button type="button" className="btn-primary inline-flex items-center gap-2" onClick={() => void connectWallet()}>
          <Plug size={16} /> Reconnect Wallet
        </button>
      </div>
    );
  }

  return (
    <div className="glass-panel p-6 space-y-5">
      <h2 className="text-2xl font-bold">Wallet Session Review</h2>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
        <p><span className="text-gray-400">Adapter:</span> {providerLabel ?? "Unknown"}</p>
        <p><span className="text-gray-400">Public Key:</span> {walletAddress ?? "Unknown"}</p>
        <p><span className="text-gray-400">Network:</span> {network ?? "Unknown"}</p>
        <p><span className="text-gray-400">Session Age:</span> {sessionAgeMinutes != null ? `${sessionAgeMinutes} min` : "Unknown"}</p>
      </div>
      {warnings.length > 0 && (
        <div className="rounded-xl border border-amber-400/30 bg-amber-500/10 p-3 text-sm text-amber-200">
          <p className="font-semibold flex items-center gap-2"><AlertTriangle size={14} /> Review Warnings</p>
          {warnings.map((warning) => <p key={warning}>{warning}</p>)}
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn-secondary inline-flex items-center gap-2" onClick={disconnectWallet}>
          <Unplug size={16} /> Disconnect
        </button>
        <button type="button" className="btn-primary inline-flex items-center gap-2" onClick={() => void connectWallet({ providerId: "freighter" })}>
          <RefreshCw size={16} /> Reconnect
        </button>
      </div>
    </div>
  );
}
