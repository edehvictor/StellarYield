import { AlertTriangle, Plug, RefreshCw, Unplug, Shield, Clock, Globe, Eye } from "lucide-react";
import { useMemo, useEffect, useState, useCallback } from "react";
import { useWallet } from "../context/useWallet";
import { isSessionExpired, isSessionStale, onSessionEvent, loadStoredSession } from "./session";
import type { SessionPermission, WalletSession } from "./types";

const PERMISSION_LABELS: Record<SessionPermission, { label: string; icon: string; description: string }> = {
  read: { label: "Read", icon: "👁", description: "View wallet address and balance" },
  sign: { label: "Sign", icon: "✍️", description: "Sign transactions with your wallet" },
  trade: { label: "Trade", icon: "🔄", description: "Execute swaps and deposits" },
  govern: { label: "Govern", icon: "🏛", description: "Vote on governance proposals" },
};

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

  const [crossTabUpdate, setCrossTabUpdate] = useState<WalletSession | null>(null);
  const [showPermissionDetail, setShowPermissionDetail] = useState(false);

  useEffect(() => {
    const unsub = onSessionEvent((event) => {
      if (event.type === "disconnect") {
        window.location.reload();
      } else if (event.type === "account-change" && event.payload) {
        setCrossTabUpdate(event.payload);
      }
    });
    return unsub;
  }, []);

  const storedSession = loadStoredSession();
  const effectiveSession = useMemo(() => {
    if (crossTabUpdate) return crossTabUpdate;
    return storedSession;
  }, [crossTabUpdate, storedSession]);

  const sessionAgeMinutes = minutesSince(connectedAt);
  const lastActivityMinutes = minutesSince(lastActivityAt);
  const isStale = (lastActivityMinutes ?? Number.MAX_SAFE_INTEGER) > 30;
  const isExpired = effectiveSession ? isSessionExpired(effectiveSession) : false;
  const lastVerifiedAt = effectiveSession?.lastVerifiedAt ?? null;
  const lastVerifiedMinutes = minutesSince(lastVerifiedAt);
  const permissions = effectiveSession?.permissions ?? [];
  const origin = effectiveSession?.origin;
  const providerAvailable = effectiveSession?.providerAvailable;

  const needsReverification = useMemo(() => {
    if (!lastVerifiedMinutes) return true;
    return lastVerifiedMinutes > 60;
  }, [lastVerifiedMinutes]);

  const warnings = useMemo(() => {
    const items: string[] = [];
    if (!providerId) items.push("Missing wallet adapter metadata.");
    if (!network) items.push("Missing wallet network state.");
    if (isStale) items.push("Session appears stale based on last activity.");
    if (isExpired) items.push("Session has expired. Reconnect to continue.");
    if (providerAvailable === false) items.push("Wallet provider may no longer be available in this browser.");
    if (needsReverification) items.push("Session needs re-verification for sensitive actions.");
    if (crossTabUpdate) items.push("Session updated from another tab.");
    return items;
  }, [providerId, network, isStale, isExpired, providerAvailable, needsReverification, crossTabUpdate]);

  const handleReconnect = useCallback(async () => {
    try {
      await connectWallet({ providerId: providerId ?? "freighter" });
    } catch (err) {
      console.error("Reconnect failed:", err);
    }
  }, [connectWallet, providerId]);

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
        {lastActivityMinutes != null && (
          <p><span className="text-gray-400">Last Activity:</span> {lastActivityMinutes} min ago</p>
        )}
        {lastVerifiedAt && (
          <p><span className="text-gray-400">Last Verified:</span> {lastVerifiedMinutes != null ? `${lastVerifiedMinutes} min ago` : "Unknown"}</p>
        )}
      </div>

      {/* Origin info */}
      {origin && (
        <div className="rounded-xl border border-white/10 bg-white/5 p-3 text-sm">
          <p className="font-semibold flex items-center gap-2 mb-1"><Globe size={14} /> Session Origin</p>
          <p className="text-gray-400">Tab: <span className="text-gray-200 font-mono text-xs">{origin.tabId}</span></p>
          <p className="text-gray-400">Created from: <span className="text-gray-200 font-mono text-xs">{origin.origin}</span></p>
          {origin.userAgent && (
            <p className="text-gray-400 text-xs mt-1 truncate">UA: {origin.userAgent}</p>
          )}
        </div>
      )}

      {/* Warnings */}
      {warnings.length > 0 && (
        <div className="rounded-xl border border-amber-400/30 bg-amber-500/10 p-3 text-sm text-amber-200">
          <p className="font-semibold flex items-center gap-2"><AlertTriangle size={14} /> Review Warnings</p>
          {warnings.map((warning) => <p key={warning}>{warning}</p>)}
        </div>
      )}

      {/* Permission Review */}
      <div className="rounded-xl border border-white/10 bg-white/5 p-3 text-sm">
        <button
          type="button"
          onClick={() => setShowPermissionDetail(!showPermissionDetail)}
          className="w-full font-semibold flex items-center justify-between gap-2 hover:text-white transition-colors"
        >
          <span className="flex items-center gap-2"><Shield size={14} /> Active Permissions ({permissions.length})</span>
          <Eye size={14} className={`transition-transform ${showPermissionDetail ? "rotate-180" : ""}`} />
        </button>

        {showPermissionDetail && (
          <div className="mt-3 space-y-2">
            {permissions.length === 0 ? (
              <p className="text-gray-500">No permissions tracked for this session.</p>
            ) : (
              permissions.map((perm) => {
                const info = PERMISSION_LABELS[perm];
                return (
                  <div key={perm} className="flex items-start gap-2 p-2 rounded-lg bg-white/5">
                    <span className="text-base">{info.icon}</span>
                    <div>
                      <p className="text-gray-200 font-medium">{info.label}</p>
                      <p className="text-gray-500 text-xs">{info.description}</p>
                    </div>
                  </div>
                );
              })
            )}
            <p className="text-xs text-gray-500 mt-2">
              Permissions are determined by wallet type and verification status.
              {needsReverification && " Re-verification required for sign/trade permissions."}
            </p>
          </div>
        )}
      </div>

      {/* Status badges */}
      <div className="flex flex-wrap gap-2 text-xs">
        <span className={`px-2 py-1 rounded-full border ${
          effectiveSession?.verificationStatus === "verified"
            ? "border-green-500/30 bg-green-500/10 text-green-300"
            : "border-amber-500/30 bg-amber-500/10 text-amber-300"
        }`}>
          {effectiveSession?.verificationStatus === "verified" ? "✓ Verified" : "⚠ Degraded"}
        </span>
        {isStale && (
          <span className="px-2 py-1 rounded-full border border-orange-500/30 bg-orange-500/10 text-orange-300 flex items-center gap-1">
            <Clock size={10} /> Stale
          </span>
        )}
        {isExpired && (
          <span className="px-2 py-1 rounded-full border border-red-500/30 bg-red-500/10 text-red-300 flex items-center gap-1">
            <AlertTriangle size={10} /> Expired
          </span>
        )}
        {providerAvailable === false && (
          <span className="px-2 py-1 rounded-full border border-red-500/30 bg-red-500/10 text-red-300">
            Provider Unavailable
          </span>
        )}
      </div>

      {/* Actions */}
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn-secondary inline-flex items-center gap-2" onClick={disconnectWallet}>
          <Unplug size={16} /> Disconnect
        </button>
        <button type="button" className="btn-primary inline-flex items-center gap-2" onClick={() => void handleReconnect()}>
          <RefreshCw size={16} /> Reconnect
        </button>
      </div>
    </div>
  );
}
