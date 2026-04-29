/**
 * YieldForGood.tsx
 *
 * "Yield for Good" UI component — allows users to toggle automatic
 * yield donation routing to a whitelisted charity address.
 *
 * Located at: /client/src/features/donations/YieldForGood.tsx
 */
import { useState, useEffect, useCallback } from "react";
import { Heart, Loader2, CheckCircle, AlertCircle } from "lucide-react";
import { useWallet } from "../../context/useWallet";
import { getApiBaseUrl } from "../../lib/api";

const API_BASE = getApiBaseUrl();

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
    const [selectedBps, setSelectedBps] = useState<number>(500);
    const [selectedCharityId, setSelectedCharityId] = useState<string>(CHARITIES[0].id);
    const [totalDonated, setTotalDonated] = useState<number | null>(null);
    const [loading, setLoading] = useState(false);
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // ── Fetch current config & global counter ────────────────────────────

    const fetchConfig = useCallback(async () => {
        if (!walletAddress) return;
        setLoading(true);
        try {
            const [configRes, statsRes] = await Promise.all([
                fetch(
                    `${API_BASE}/api/donations/config/${encodeURIComponent(walletAddress)}`,
                ),
                fetch(`${API_BASE}/api/donations/total`),
            ]);

            if (configRes.ok) {
                const data: DonationConfig = await configRes.json();
                setConfig(data);
                if (data.bps > 0) setSelectedBps(data.bps);
                if (data.charityId) setSelectedCharityId(data.charityId);
            }

            if (statsRes.ok) {
                const stats: { totalDonated: number } = await statsRes.json();
                setTotalDonated(stats.totalDonated);
            }
        } catch {
            // Non-fatal — show empty state
        } finally {
            setLoading(false);
        }
    }, [walletAddress]);

    useEffect(() => {
        if (isConnected && walletAddress) {
            void fetchConfig();
        }
    }, [isConnected, walletAddress, fetchConfig]);

    // ── Save handler ────────────────────────────────────────────────────────

    const handleSave = async () => {
        if (!walletAddress) return;
        setSaving(true);
        setError(null);
        setSaved(false);

        try {
            const charity = CHARITIES.find((c) => c.id === selectedCharityId);
            if (!charity) throw new Error("Select a valid charity.");

            const res = await fetch(`${API_BASE}/api/donations/set`, {
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
            const res = await fetch(`${API_BASE}/api/donations/set`, {
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
        } catch (err) {
            setError(err instanceof Error ? err.message : "Failed to disable donation.");
        } finally {
            setSaving(false);
        }
    };

    // ── Not connected ──────────────────────────────────────────────────────

    if (!isConnected) {
        return (
            <div className="glass-panel rounded-2xl p-6 flex flex-col items-center text-center gap-3">
                <Heart size={32} className="text-pink-400" />
                <h3 className="font-semibold text-white">Yield for Good</h3>
                <p className="text-sm text-gray-400">
                    Connect your wallet to enable automatic yield donations.
                </p>
            </div>
        );
    }

    if (loading) {
        return (
            <div className="glass-panel rounded-2xl p-6 flex items-center justify-center gap-3">
                <Loader2 size={20} className="animate-spin text-pink-400" />
                <span className="text-sm text-gray-400">Loading…</span>
            </div>
        );
    }

    return (
        <div className="glass-panel rounded-2xl p-6 space-y-5">
            {/* Header */}
            <div className="flex items-center gap-3">
                <span className="w-10 h-10 rounded-full bg-pink-500/20 flex items-center justify-center">
                    <Heart size={20} className="text-pink-400" />
                </span>
                <div>
                    <h3 className="font-semibold text-white">Yield for Good</h3>
                    <p className="text-xs text-gray-400">
                        Auto-donate a slice of your generated yield.
                    </p>
                </div>
                {config.bps > 0 && (
                    <span className="ml-auto text-xs bg-pink-500/20 text-pink-400 px-2 py-1 rounded-full">
                        Active — {config.bps / 100}%
                    </span>
                )}
            </div>

            {/* Global counter */}
            {totalDonated !== null && (
                <div className="rounded-xl bg-pink-500/10 border border-pink-500/20 px-4 py-3 text-center">
                    <p className="text-xs text-gray-400">Protocol-wide total donated</p>
                    <p className="text-xl font-extrabold text-pink-300">
                        {new Intl.NumberFormat("en-US").format(totalDonated)} YIELD
                    </p>
                </div>
            )}

            {/* Percentage selector */}
            <div>
                <p className="text-xs text-gray-400 mb-2">Yield split</p>
                <div className="flex gap-2 flex-wrap">
                    {BPS_OPTIONS.map((opt) => (
                        <button
                            key={opt.bps}
                            onClick={() => setSelectedBps(opt.bps)}
                            className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${selectedBps === opt.bps
                                    ? "bg-pink-500 text-white"
                                    : "bg-gray-800 text-gray-300 hover:bg-gray-700"
                                }`}
                        >
                            {opt.label}
                        </button>
                    ))}
                </div>
            </div>

            {/* Charity selector */}
            <div>
                <p className="text-xs text-gray-400 mb-2">Choose charity</p>
                <div className="space-y-2">
                    {CHARITIES.map((charity) => (
                        <label
                            key={charity.id}
                            className={`flex items-start gap-3 p-3 rounded-xl border cursor-pointer transition-all ${selectedCharityId === charity.id
                                    ? "border-pink-500/50 bg-pink-500/10"
                                    : "border-gray-700 bg-gray-800/40 hover:border-gray-600"
                                }`}
                        >
                            <input
                                type="radio"
                                name="charity"
                                value={charity.id}
                                checked={selectedCharityId === charity.id}
                                onChange={() => setSelectedCharityId(charity.id)}
                                className="mt-0.5 accent-pink-500"
                            />
                            <div>
                                <p className="text-sm font-medium text-white">{charity.name}</p>
                                <p className="text-xs text-gray-400">{charity.description}</p>
                            </div>
                        </label>
                    ))}
                </div>
            </div>

            {/* Error */}
            {error && (
                <div className="flex items-center gap-2 text-red-400 text-sm">
                    <AlertCircle size={16} />
                    {error}
                </div>
            )}

            {/* Actions */}
            <div className="flex gap-3">
                <button
                    onClick={() => void handleSave()}
                    disabled={saving}
                    className="flex-1 py-2.5 rounded-xl font-semibold text-sm bg-gradient-to-r from-pink-500 to-rose-600 hover:from-pink-400 hover:to-rose-500 text-white transition-all active:scale-95 disabled:opacity-40 flex items-center justify-center gap-2"
                >
                    {saving ? (
                        <Loader2 size={16} className="animate-spin" />
                    ) : saved ? (
                        <CheckCircle size={16} />
                    ) : (
                        <Heart size={16} />
                    )}
                    {saved ? "Saved!" : saving ? "Saving…" : "Save Donation"}
                </button>

                {config.bps > 0 && (
                    <button
                        onClick={() => void handleDisable()}
                        disabled={saving}
                        className="px-4 py-2.5 rounded-xl font-semibold text-sm bg-gray-700 hover:bg-gray-600 text-gray-300 transition-all active:scale-95 disabled:opacity-40"
                    >
                        Disable
                    </button>
                )}
            </div>
        </div>
    );
}
