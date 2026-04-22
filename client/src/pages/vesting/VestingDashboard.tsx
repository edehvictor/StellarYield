/**
 * VestingDashboard.tsx
 *
 * /vesting — Token Vesting & Claim UI Dashboard
 *
 * Shows the connected wallet's vesting schedule including:
 *  - Total allocation, amount vested, amount claimed (progress bar)
 *  - Countdown timer to the next cliff / linear unlock tick
 *  - Claim button that submits a `claim_vested` contract transaction
 *
 * Gracefully handles wallets with no vesting schedule without showing
 * error stack traces.
 */
import { useState, useEffect, useCallback } from "react";
import {
    Clock,
    Gift,
    CheckCircle,
    Loader2,
    AlertCircle,
    Lock,
} from "lucide-react";
import { useWallet } from "../../context/useWallet";
import {
    fetchVestingSchedule,
    claimVested,
    formatTokens,
    vestedPercent,
    claimedPercent,
    type VestingSchedule,
} from "./vestingService";
import { useCountdown } from "./useCountdown";
import { decodeTransactionError } from "../../utils/errorDecoder";
import TransactionFailedModal from "../../components/transaction/TransactionFailedModal";
import type { DecodedError } from "../../utils/errorDecoder";

// ── Sub-components ──────────────────────────────────────────────────────

interface ProgressBarProps {
    vestedPct: number;
    claimedPct: number;
}

function VestingProgressBar({ vestedPct, claimedPct }: ProgressBarProps) {
    return (
        <div
            aria-label="Vesting progress"
            className="w-full h-4 rounded-full bg-gray-800 overflow-hidden relative"
        >
            {/* Claimed portion */}
            <div
                className="absolute h-full bg-indigo-600 rounded-full transition-all duration-700"
                style={{ width: `${claimedPct}%` }}
                title={`Claimed: ${claimedPct.toFixed(1)}%`}
            />
            {/* Vested-but-unclaimed portion */}
            <div
                className="absolute h-full bg-indigo-400/60 rounded-full transition-all duration-700"
                style={{ width: `${vestedPct}%` }}
                title={`Vested: ${vestedPct.toFixed(1)}%`}
            />
        </div>
    );
}

interface CountdownDisplayProps {
    targetTimestamp: number;
    label: string;
}

function CountdownDisplay({ targetTimestamp, label }: CountdownDisplayProps) {
    const { days, hours, minutes, seconds, expired } =
        useCountdown(targetTimestamp);

    if (expired) {
        return (
            <p className="text-xs text-gray-400">
                {label}: <span className="text-green-400 font-semibold">Unlocked</span>
            </p>
        );
    }

    function pad(n: number) {
        return String(n).padStart(2, "0");
    }

    return (
        <div>
            <p className="text-xs text-gray-400 mb-1">{label}</p>
            <div className="flex gap-2 text-center">
                {[
                    { value: days, unit: "D" },
                    { value: hours, unit: "H" },
                    { value: minutes, unit: "M" },
                    { value: seconds, unit: "S" },
                ].map(({ value, unit }) => (
                    <div
                        key={unit}
                        className="rounded-lg bg-gray-800 px-2 py-1 min-w-[2.5rem]"
                    >
                        <div className="text-white font-mono font-bold text-sm">
                            {pad(value)}
                        </div>
                        <div className="text-gray-500 text-[10px]">{unit}</div>
                    </div>
                ))}
            </div>
        </div>
    );
}

// ── Main Page ───────────────────────────────────────────────────────────

export default function VestingDashboard() {
    const { isConnected, walletAddress } = useWallet();

    const [schedule, setSchedule] = useState<VestingSchedule | null>(null);
    const [loading, setLoading] = useState(false);
    const [claiming, setClaiming] = useState(false);
    const [claimHash, setClaimHash] = useState<string | null>(null);
    const [modalError, setModalError] = useState<DecodedError | null>(null);

    const fetchSchedule = useCallback(async () => {
        if (!walletAddress) return;
        setLoading(true);
        const data = await fetchVestingSchedule(walletAddress);
        setSchedule(data);
        setLoading(false);
    }, [walletAddress]);

    useEffect(() => {
        if (isConnected && walletAddress) {
            void fetchSchedule();
        }
    }, [isConnected, walletAddress, fetchSchedule]);

    // ── Empty / unauthenticated states ─────────────────────────────────

    if (!isConnected) {
        return (
            <div className="flex flex-col items-center justify-center py-24 text-center">
                <Lock size={48} className="text-indigo-400 mb-4" />
                <h2 className="text-2xl font-bold mb-2">Token Vesting</h2>
                <p className="text-gray-400">
                    Connect your Freighter wallet to view your vesting schedule.
                </p>
            </div>
        );
    }

    if (loading) {
        return (
            <div className="flex flex-col items-center justify-center py-24">
                <Loader2 size={40} className="text-indigo-400 animate-spin mb-4" />
                <p className="text-gray-400">Loading vesting schedule…</p>
            </div>
        );
    }

    if (!schedule) {
        return (
            <div className="flex flex-col items-center justify-center py-24 text-center">
                <AlertCircle size={48} className="text-gray-500 mb-4" />
                <h2 className="text-2xl font-bold mb-2">No Vesting Schedule</h2>
                <p className="text-gray-400 max-w-sm">
                    This wallet does not have an active vesting schedule. If you believe
                    this is a mistake, confirm you are using the correct wallet address.
                </p>
            </div>
        );
    }

    // ── Claim handler ──────────────────────────────────────────────────

    const handleClaim = async () => {
        if (!walletAddress || schedule.claimableAmount === 0n) return;
        setClaiming(true);
        const result = await claimVested(walletAddress);
        setClaiming(false);

        if (result.success) {
            setClaimHash(result.hash ?? null);
            // Refresh schedule after successful claim
            void fetchSchedule();
        } else {
            const decoded = decodeTransactionError(result.error ?? "Unknown error");
            setModalError(decoded);
        }
    };

    // ── Progress calculations ──────────────────────────────────────────

    const vPct = vestedPercent(schedule);
    const cPct = claimedPercent(schedule);
    const nowSec = Math.floor(Date.now() / 1000);
    const isCliffReached = nowSec >= schedule.cliffTimestamp;
    const isFullyVested = nowSec >= schedule.endTimestamp;
    const hasClaimable = schedule.claimableAmount > 0n;

    // Use next unlock if cliff has been reached, otherwise use cliff
    const countdownTarget = isCliffReached
        ? schedule.nextUnlockTimestamp
        : schedule.cliffTimestamp;
    const countdownLabel = isCliffReached ? "Next unlock in" : "Cliff unlocks in";

    return (
        <>
            {modalError && (
                <TransactionFailedModal
                    error={modalError}
                    onClose={() => setModalError(null)}
                />
            )}

            <div className="space-y-8 max-w-2xl mx-auto animate-in fade-in slide-in-from-bottom-4 duration-700">
                {/* Header */}
                <header>
                    <h2 className="text-3xl font-extrabold tracking-tight flex items-center gap-2">
                        <Gift size={28} className="text-indigo-400" /> Token Vesting
                    </h2>
                    <p className="text-gray-400 mt-1">
                        Track your unlock schedule and claim vested $YIELD tokens.
                    </p>
                </header>

                {/* Allocation overview */}
                <div className="glass-panel rounded-2xl p-6 space-y-5">
                    <div className="flex items-center justify-between">
                        <h3 className="font-semibold text-white">Allocation Overview</h3>
                        {isFullyVested && (
                            <span className="text-xs bg-green-500/20 text-green-400 px-2 py-1 rounded-full">
                                Fully Vested
                            </span>
                        )}
                    </div>

                    {/* Stats row */}
                    <div className="grid grid-cols-3 gap-4 text-center">
                        <div className="rounded-xl bg-gray-800/60 p-3">
                            <p className="text-xs text-gray-400 mb-1">Total Allocation</p>
                            <p className="text-sm font-bold text-white">
                                {formatTokens(schedule.totalAllocation)}
                            </p>
                        </div>
                        <div className="rounded-xl bg-indigo-500/10 border border-indigo-500/20 p-3">
                            <p className="text-xs text-gray-400 mb-1">Vested</p>
                            <p className="text-sm font-bold text-indigo-300">
                                {formatTokens(schedule.vestedAmount)}
                            </p>
                        </div>
                        <div className="rounded-xl bg-gray-800/60 p-3">
                            <p className="text-xs text-gray-400 mb-1">Claimed</p>
                            <p className="text-sm font-bold text-green-400">
                                {formatTokens(schedule.claimedAmount)}
                            </p>
                        </div>
                    </div>

                    {/* Progress bar */}
                    <div className="space-y-2">
                        <div className="flex justify-between text-xs text-gray-400">
                            <span>Claimed {cPct.toFixed(1)}%</span>
                            <span>Vested {vPct.toFixed(1)}%</span>
                        </div>
                        <VestingProgressBar vestedPct={vPct} claimedPct={cPct} />
                        <div className="flex items-center gap-3 text-xs text-gray-500">
                            <span className="flex items-center gap-1">
                                <span className="inline-block w-3 h-3 rounded-full bg-indigo-600" />{" "}
                                Claimed
                            </span>
                            <span className="flex items-center gap-1">
                                <span className="inline-block w-3 h-3 rounded-full bg-indigo-400/60" />{" "}
                                Vested
                            </span>
                            <span className="flex items-center gap-1">
                                <span className="inline-block w-3 h-3 rounded-full bg-gray-800" />{" "}
                                Locked
                            </span>
                        </div>
                    </div>
                </div>

                {/* Countdown timer */}
                <div className="glass-panel rounded-2xl p-6 flex items-center gap-6">
                    <span className="w-12 h-12 rounded-full bg-indigo-500/20 flex items-center justify-center flex-shrink-0">
                        <Clock size={24} className="text-indigo-400" />
                    </span>
                    <div className="flex-1">
                        {isFullyVested ? (
                            <p className="text-gray-300 text-sm">
                                All tokens have fully vested.
                            </p>
                        ) : (
                            <CountdownDisplay
                                targetTimestamp={countdownTarget}
                                label={countdownLabel}
                            />
                        )}
                    </div>
                </div>

                {/* Claim section */}
                <div className="glass-panel rounded-2xl p-6 space-y-4">
                    <h3 className="font-semibold text-white">Claim Vested Tokens</h3>

                    {claimHash ? (
                        <div className="flex items-center gap-3 text-green-400">
                            <CheckCircle size={20} />
                            <div>
                                <p className="font-semibold text-sm">Claim successful!</p>
                                <p className="text-xs text-gray-400 font-mono break-all">
                                    Tx: {claimHash}
                                </p>
                            </div>
                        </div>
                    ) : (
                        <>
                            <div className="flex justify-between text-sm">
                                <span className="text-gray-400">Available to claim</span>
                                <span className="text-white font-bold">
                                    {formatTokens(schedule.claimableAmount)}
                                </span>
                            </div>

                            <button
                                onClick={() => void handleClaim()}
                                disabled={!hasClaimable || claiming || !isCliffReached}
                                className="w-full py-3 rounded-xl font-semibold text-sm transition-all active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed
                  bg-gradient-to-r from-indigo-500 to-purple-600 hover:from-indigo-400 hover:to-purple-500 text-white shadow-lg shadow-indigo-500/20"
                            >
                                {claiming ? (
                                    <span className="flex items-center justify-center gap-2">
                                        <Loader2 size={16} className="animate-spin" /> Claiming…
                                    </span>
                                ) : !isCliffReached ? (
                                    "Cliff not reached yet"
                                ) : !hasClaimable ? (
                                    "Nothing to claim"
                                ) : (
                                    "Claim Vested Tokens"
                                )}
                            </button>

                            {!isCliffReached && (
                                <p className="text-xs text-gray-500 text-center">
                                    Tokens will be claimable once the cliff period ends.
                                </p>
                            )}
                        </>
                    )}
                </div>
            </div>
        </>
    );
}
