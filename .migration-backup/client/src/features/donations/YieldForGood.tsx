/**
 * YieldForGood.tsx
 *
 * "Yield for Good" UI component — allows users to toggle automatic
 * yield donation routing to a whitelisted charity address.
 *
 * Located at: /client/src/features/donations/YieldForGood.tsx
 */
import { useState, useEffect, useCallback } from "react";
import { Heart, Loader2, CheckCircle, AlertCircle, Users, TrendingUp } from "lucide-react";
import { useWallet } from "../../context/useWallet";
import { getApiBaseUrl } from "../../lib/api";

const getApiBase = () => {
  try {
    return getApiBaseUrl();
  } catch {
    return "";
  }
};

// ── Types ─────────────────────────────────────────────────────────────────

export interface Charity {
    id: string;
    name: string;
    address: string;
    description: string;
}

interface DonationConfig {
    bps: number;
    charityId: string | null;
}

interface DonationSummary {
    totalDonated: number;
    participatingVaults: number;
    projectedMonthlyImpact: number;
}

// ── Whitelisted charities ─────────────────────────────────────────────────

const CHARITIES: Charity[] = [
    {
        id: "open-source-fund",
        name: "Open Source Fund",
        address: "GDOPEN000STELLAR0OPEN0SOURCE0FUND0ADDRESS0000",
        description: "Funds Stellar ecosystem open-source contributors.",
    },
    {
        id: "climate-action",
        name: "Climate Action DAO",
        address: "GDCLIMATE000ACTION0DAO0STELLAR0ADDRESS000000",
        description: "Carbon offset projects verified on-chain.",
    },
    {
        id: "education-fund",
        name: "Crypto Education Fund",
        address: "GDEDUCATE000CRYPTO0FUND0STELLAR0ADDRESS0000",
        description: "Blockchain literacy programs in emerging markets.",
    },
];

// ── Percentage options ────────────────────────────────────────────────────

const BPS_OPTIONS = [
    { label: "1%", bps: 100 },
    { label: "5%", bps: 500 },
    { label: "10%", bps: 1000 },
    { label: "25%", bps: 2500 },
];

// ── Component ─────────────────────────────────────────────────────────────

/**
 * YieldForGood
 *
 * Lets the connected user select a charity and a yield-split percentage.
 * Submits the configuration to the backend which forwards it to the
 * Soroban vault contract via the relayer.
 */
export default function YieldForGood() {
    const { isConnected, walletAddress } = useWallet();

    const [config, setConfig] = useState<DonationConfig>({ bps: 0, charityId: null });
    const [summary, setSummary] = useState<DonationSummary | null>(null);
    const [selectedBps, setSelectedBps] = useState<number>(500);
    const [selectedCharityId, setSelectedCharityId] = useState<string>(CHARITIES[0].id);
    const [loading, setLoading] = useState(false);
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // ── Fetch current config & global summary ────────────────────────────

    const fetchConfig = useCallback(async () => {
        setLoading(true);
        try {
            const requests = [
                fetch(`${getApiBase()}/api/donations/summary`),
            ];
            
            if (walletAddress) {
                requests.push(fetch(`${getApiBase()}/api/donations/config/${encodeURIComponent(walletAddress)}`));
            }

            const [summaryRes, configRes] = await Promise.all(requests);

            if (summaryRes.ok) {
                const data: DonationSummary = await summaryRes.json();
                setSummary(data);
            }

            if (configRes && configRes.ok) {
                const data: DonationConfig = await configRes.json();
                setConfig(data);
                if (data.bps > 0) setSelectedBps(data.bps);
                if (data.charityId) setSelectedCharityId(data.charityId);
            }
        } catch {
            // Non-fatal — show empty state
        } finally {
            setLoading(false);
        }
    }, [walletAddress]);

    useEffect(() => {
        void fetchConfig();
    }, [fetchConfig]);

    // ── Save handler ────────────────────────────────────────────────────────

    const handleSave = async () => {
        if (!walletAddress) return;
        setSaving(true);
        setError(null);
        setSaved(false);

        try {
            const charity = CHARITIES.find((c) => c.id === selectedCharityId);
            if (!charity) throw new Error("Select a valid charity.");

            const res = await fetch(`${getApiBase()}/api/donations/set`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    address: walletAddress,
                    bps: selectedBps,
                    charityAddress: charity.address,
                }),
            });

            if (!res.ok) {
                const body = await res.json().catch(() => ({}));
                throw new Error(
                    (body as { error?: string }).error ?? `Server error ${res.status}`,
                );
            }

            setConfig({ bps: selectedBps, charityId: selectedCharityId });
            setSaved(true);
            setTimeout(() => setSaved(false), 3000);
            
            // Refresh summary to reflect new participating vault
            void fetchConfig();
        } catch (err) {
            setError(err instanceof Error ? err.message : "Failed to save donation config.");
        } finally {
            setSaving(false);
        }
    };

    // ── Disable handler ─────────────────────────────────────────────────────

    const handleDisable = async () => {
        if (!walletAddress) return;
        setSaving(true);
        setError(null);
        try {
            const res = await fetch(`${getApiBase()}/api/donations/set`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    address: walletAddress,
                    bps: 0,
                    charityAddress: CHARITIES[0].address,
                }),
            });

            if (!res.ok) throw new Error("Failed to disable donation.");
            setConfig({ bps: 0, charityId: null });
            
            // Refresh summary
            void fetchConfig();
        } catch (err) {
            setError(err instanceof Error ? err.message : "Failed to disable donation.");
        } finally {
            setSaving(false);
        }
    };

    // ── Loading state ──────────────────────────────────────────────────────

    if (loading && !summary) {
        return (
            <div className="glass-panel rounded-2xl p-6 flex items-center justify-center gap-3">
                <Loader2 size={20} className="animate-spin text-pink-400" />
                <span className="text-sm text-gray-400">Loading…</span>
            </div>
        );
    }

    return (
        <div className="glass-panel rounded-2xl p-6 space-y-6">
            {/* Header */}
            <div className="flex items-center gap-3">
                <span className="w-10 h-10 rounded-full bg-pink-500/20 flex items-center justify-center">
                    <Heart size={20} className="text-pink-400" />
                </span>
                <div>
                    <h3 className="font-semibold text-white text-lg">Yield for Good</h3>
                    <p className="text-xs text-gray-400">
                        Join the movement to auto-donate yield to verified charities.
                    </p>
                </div>
                {config.bps > 0 && (
                    <span className="ml-auto text-xs bg-pink-500/20 text-pink-400 px-3 py-1 rounded-full border border-pink-500/20 font-bold animate-pulse">
                        Active — {config.bps / 100}%
                    </span>
                )}
            </div>

            {/* Impact Summary Cards */}
            {summary && (
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <div className="rounded-xl bg-gray-800/40 border border-gray-700/50 p-4 flex flex-col items-center text-center transition-all hover:bg-gray-800/60">
                        <Heart size={16} className="text-pink-400 mb-2" />
                        <p className="text-[10px] uppercase tracking-widest text-gray-500 font-bold mb-1">Total Donated</p>
                        <p className="text-xl font-black text-white">
                            {new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(summary.totalDonated)}
                            <span className="text-[10px] text-gray-500 ml-1">YIELD</span>
                        </p>
                    </div>
                    <div className="rounded-xl bg-gray-800/40 border border-gray-700/50 p-4 flex flex-col items-center text-center transition-all hover:bg-gray-800/60">
                        <Users size={16} className="text-blue-400 mb-2" />
                        <p className="text-[10px] uppercase tracking-widest text-gray-500 font-bold mb-1">Active Donors</p>
                        <p className="text-xl font-black text-white">
                            {summary.participatingVaults}
                            <span className="text-[10px] text-gray-500 ml-1">VAULTS</span>
                        </p>
                    </div>
                    <div className="rounded-xl bg-pink-500/5 border border-pink-500/20 p-4 flex flex-col items-center text-center transition-all hover:bg-pink-500/10">
                        <TrendingUp size={16} className="text-pink-400 mb-2" />
                        <p className="text-[10px] uppercase tracking-widest text-pink-500/60 font-bold mb-1">Monthly Impact</p>
                        <p className="text-xl font-black text-pink-400">
                            +${new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(summary.projectedMonthlyImpact)}
                        </p>
                    </div>
                </div>
            )}

            {!isConnected ? (
                <div className="bg-gray-900/40 rounded-xl p-6 border border-gray-800 text-center space-y-3">
                    <Heart size={32} className="text-gray-600 mx-auto" />
                    <p className="text-sm text-gray-400 max-w-[240px] mx-auto">
                        Connect your wallet to configure your personal yield donation split.
                    </p>
                </div>
            ) : (
                <div className="space-y-6 pt-2">
                    {/* Percentage selector */}
                    <div>
                        <div className="flex justify-between items-end mb-3">
                            <p className="text-xs font-bold text-gray-400 uppercase tracking-wider">Yield Split</p>
                            <span className="text-xs text-pink-400 font-medium">{selectedBps / 100}% of your yield</span>
                        </div>
                        <div className="flex gap-2 flex-wrap">
                            {BPS_OPTIONS.map((opt) => (
                                <button
                                    key={opt.bps}
                                    onClick={() => setSelectedBps(opt.bps)}
                                    className={`px-4 py-2 rounded-xl text-xs font-bold transition-all flex-1 min-w-[60px] ${selectedBps === opt.bps
                                            ? "bg-pink-500 text-white shadow-lg shadow-pink-500/20 scale-105"
                                            : "bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-gray-200"
                                        }`}
                                >
                                    {opt.label}
                                </button>
                            ))}
                        </div>
                    </div>

                    {/* Charity selector */}
                    <div>
                        <p className="text-xs font-bold text-gray-400 uppercase tracking-wider mb-3">Choose Impact Area</p>
                        <div className="space-y-2">
                            {CHARITIES.map((charity) => (
                                <label
                                    key={charity.id}
                                    className={`flex items-start gap-3 p-4 rounded-xl border cursor-pointer transition-all ${selectedCharityId === charity.id
                                            ? "border-pink-500/50 bg-pink-500/10"
                                            : "border-gray-800 bg-gray-800/40 hover:border-gray-700"
                                        }`}
                                >
                                    <input
                                        type="radio"
                                        name="charity"
                                        value={charity.id}
                                        checked={selectedCharityId === charity.id}
                                        onChange={() => setSelectedCharityId(charity.id)}
                                        className="mt-1 accent-pink-500 h-4 w-4"
                                    />
                                    <div>
                                        <p className="text-sm font-bold text-white">{charity.name}</p>
                                        <p className="text-xs text-gray-400 leading-relaxed mt-0.5">{charity.description}</p>
                                    </div>
                                </label>
                            ))}
                        </div>
                    </div>

                    {/* Error */}
                    {error && (
                        <div className="flex items-center gap-2 text-red-400 text-sm bg-red-400/10 p-3 rounded-lg border border-red-400/20">
                            <AlertCircle size={16} />
                            {error}
                        </div>
                    )}

                    {/* Actions */}
                    <div className="flex gap-3 pt-2">
                        <button
                            onClick={() => void handleSave()}
                            disabled={saving}
                            className="flex-[2] py-3.5 rounded-xl font-black text-sm bg-gradient-to-r from-pink-500 to-rose-600 hover:from-pink-400 hover:to-rose-500 text-white transition-all active:scale-95 disabled:opacity-40 flex items-center justify-center gap-2 shadow-xl shadow-pink-500/20"
                        >
                            {saving ? (
                                <Loader2 size={18} className="animate-spin" />
                            ) : saved ? (
                                <CheckCircle size={18} />
                            ) : (
                                <Heart size={18} />
                            )}
                            {saved ? "Split Saved!" : saving ? "Saving…" : "Activate Donation"}
                        </button>

                        {config.bps > 0 && (
                            <button
                                onClick={() => void handleDisable()}
                                disabled={saving}
                                className="flex-1 py-3.5 rounded-xl font-bold text-sm bg-gray-800 hover:bg-gray-700 text-gray-400 transition-all active:scale-95 disabled:opacity-40 border border-gray-700"
                            >
                                Disable
                            </button>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}
