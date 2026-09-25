/**
 * vestingService.ts
 *
 * Client-side helpers for interacting with the on-chain vesting contract
 * via the Soroban RPC and submitting claim_vested transactions through
 * the relayer or directly via Freighter.
 *
 * @module vestingService
 */
import * as StellarSdk from "@stellar/stellar-sdk";
import freighter from "@stellar/freighter-api";
import { RPC_URL, NETWORK_PASSPHRASE } from "../../services/soroban";
import { getContractId, validateContractRegistryEntry } from "../../services/contractRegistry";

export interface VestingSchedule {
    /** Total tokens allocated to this address (stroops). */
    totalAllocation: bigint;
    /** Tokens that have vested so far (stroops). */
    vestedAmount: bigint;
    /** Tokens already claimed (stroops). */
    claimedAmount: bigint;
    /** Unclaimed-but-vested tokens ready to withdraw (stroops). */
    claimableAmount: bigint;
    /** Unix timestamp (seconds) when cliff ends. */
    cliffTimestamp: number;
    /** Unix timestamp (seconds) when full vesting completes. */
    endTimestamp: number;
    /** Unix timestamp of next linear unlock tick (seconds). */
    nextUnlockTimestamp: number;
    /** Vesting start timestamp (seconds). */
    startTimestamp: number;
}

/** Raw vesting schedule fields as returned by `scValToNative` for the contract's read call. */
export interface RawVestingScheduleFields {
    total_allocation?: unknown;
    vested_amount?: unknown;
    claimed_amount?: unknown;
    cliff_timestamp?: unknown;
    end_timestamp?: unknown;
    next_unlock_timestamp?: unknown;
    start_timestamp?: unknown;
}

/** Coerces a raw amount field to a non-negative bigint, defaulting to 0n. */
function toNonNegativeBigInt(value: unknown): bigint {
    try {
        if (typeof value === "bigint") {
            return value < 0n ? 0n : value;
        }
        if (typeof value === "number" && Number.isFinite(value)) {
            const truncated = BigInt(Math.trunc(value));
            return truncated < 0n ? 0n : truncated;
        }
        if (typeof value === "string" && value.trim() !== "") {
            const parsed = BigInt(value.trim());
            return parsed < 0n ? 0n : parsed;
        }
    } catch {
        // Fall through to the default below on any parse failure.
    }
    return 0n;
}

/** Coerces a raw timestamp field to a whole-second Unix timestamp, defaulting to 0. */
function toTimestamp(value: unknown): number {
    if (typeof value === "bigint") {
        return Number(value);
    }
    if (typeof value === "number" && Number.isFinite(value)) {
        return Math.trunc(value);
    }
    if (typeof value === "string" && value.trim() !== "") {
        const parsed = Number(value.trim());
        if (Number.isFinite(parsed)) {
            return Math.trunc(parsed);
        }
    }
    return 0;
}

/**
 * Normalizes raw on-chain vesting schedule fields into a well-formed,
 * internally-consistent `VestingSchedule`.
 *
 * Deterministic and pure: the same input always produces the same output,
 * independent of wall-clock time or external state. Defensively clamps
 * amounts so callers never see impossible states even if the contract
 * returns malformed or out-of-order data:
 *   - negative amounts clamp to 0
 *   - `vestedAmount` never exceeds `totalAllocation`
 *   - `claimedAmount` never exceeds `vestedAmount`
 *   - `claimableAmount` is derived as `vestedAmount - claimedAmount`, floored at 0
 */
export function normalizeVestingSchedule(raw: RawVestingScheduleFields): VestingSchedule {
    const totalAllocation = toNonNegativeBigInt(raw.total_allocation);

    let vestedAmount = toNonNegativeBigInt(raw.vested_amount);
    if (vestedAmount > totalAllocation) {
        vestedAmount = totalAllocation;
    }

    let claimedAmount = toNonNegativeBigInt(raw.claimed_amount);
    if (claimedAmount > vestedAmount) {
        claimedAmount = vestedAmount;
    }

    const claimableAmount = vestedAmount - claimedAmount > 0n ? vestedAmount - claimedAmount : 0n;

    return {
        totalAllocation,
        vestedAmount,
        claimedAmount,
        claimableAmount,
        cliffTimestamp: toTimestamp(raw.cliff_timestamp),
        endTimestamp: toTimestamp(raw.end_timestamp),
        nextUnlockTimestamp: toTimestamp(raw.next_unlock_timestamp),
        startTimestamp: toTimestamp(raw.start_timestamp),
    };
}

/**
 * Fetches the vesting schedule for the given wallet address from the
 * on-chain contract via a read-only simulation.
 *
 * Returns `null` when the wallet has no active vesting schedule.
 *
 * @param walletAddress - Stellar account ID of the beneficiary.
 */
export async function fetchVestingSchedule(
    walletAddress: string,
): Promise<VestingSchedule | null> {
    const vestingContractId = getContractId("vesting");
    if (!vestingContractId) {
        // Contract not configured — return null gracefully (no error trace).
        return null;
    }

    try {
        const server = new StellarSdk.rpc.Server(RPC_URL);
        const contract = new StellarSdk.Contract(vestingContractId);

        const account = await server.getAccount(walletAddress);
        const tx = new StellarSdk.TransactionBuilder(account, {
            fee: StellarSdk.BASE_FEE,
            networkPassphrase: NETWORK_PASSPHRASE,
        })
            .addOperation(
                contract.call(
                    "get_vesting_schedule",
                    StellarSdk.nativeToScVal(walletAddress, { type: "address" }),
                ),
            )
            .setTimeout(30)
            .build();

        const result = await server.simulateTransaction(tx);

        if (
            StellarSdk.rpc.Api.isSimulationError(result) ||
            !("result" in result) ||
            !result.result
        ) {
            return null;
        }

        const val = StellarSdk.scValToNative(result.result.retval) as RawVestingScheduleFields;

        return normalizeVestingSchedule(val);
    } catch {
        // Gracefully return null — do not expose stack traces to users.
        return null;
    }
}

export interface ClaimResult {
    success: boolean;
    hash?: string;
    error?: string;
}

/**
 * Builds, signs via Freighter, and submits a `claim_vested` transaction
 * for the given wallet address.
 *
 * @param walletAddress - The beneficiary account ID.
 * @returns A `ClaimResult` indicating success or a user-friendly error.
 */
export async function claimVested(walletAddress: string): Promise<ClaimResult> {
    const vestingContractId = getContractId("vesting");
    try {
        validateContractRegistryEntry("vesting", vestingContractId);
    } catch (err) {
        return {
            success: false,
            error: err instanceof Error ? err.message : String(err),
        };
    }

    try {
        const server = new StellarSdk.rpc.Server(RPC_URL);
        const contract = new StellarSdk.Contract(vestingContractId);

        const account = await server.getAccount(walletAddress);
        const builtTx = new StellarSdk.TransactionBuilder(account, {
            fee: StellarSdk.BASE_FEE,
            networkPassphrase: NETWORK_PASSPHRASE,
        })
            .addOperation(
                contract.call(
                    "claim_vested",
                    StellarSdk.nativeToScVal(walletAddress, { type: "address" }),
                ),
            )
            .setTimeout(30)
            .build();

        // Simulate to get footprint / auth
        const sim = await server.simulateTransaction(builtTx);
        if (StellarSdk.rpc.Api.isSimulationError(sim)) {
            return {
                success: false,
                error: (sim as { error: string }).error ?? "Simulation failed",
            };
        }

        const prepared = StellarSdk.rpc.assembleTransaction(
            builtTx,
            sim,
        ).build();

        const signResult = await freighter.signTransaction(prepared.toXDR(), {
            networkPassphrase: NETWORK_PASSPHRASE,
        });

        if (signResult.error) {
            return { success: false, error: signResult.error.message };
        }

        const signedTx = StellarSdk.TransactionBuilder.fromXDR(
            signResult.signedTxXdr,
            NETWORK_PASSPHRASE,
        );

        const sendResult = await server.sendTransaction(signedTx);

        if (sendResult.status === "ERROR") {
            return {
                success: false,
                error: sendResult.errorResult?.toString() ?? "Transaction rejected",
            };
        }

        // Poll for confirmation
        const pollStart = Date.now();
        while (Date.now() - pollStart < 30_000) {
            const statusResult = await server.getTransaction(sendResult.hash);
            if (statusResult.status === StellarSdk.rpc.Api.GetTransactionStatus.SUCCESS) {
                return { success: true, hash: sendResult.hash };
            }
            if (statusResult.status === StellarSdk.rpc.Api.GetTransactionStatus.FAILED) {
                return {
                    success: false,
                    error:
                        statusResult.resultXdr?.toString() ?? "Transaction failed on-chain",
                    hash: sendResult.hash,
                };
            }
            await new Promise((r) => setTimeout(r, 2_000));
        }

        return { success: false, error: "Transaction polling timed out." };
    } catch (err) {
        return {
            success: false,
            error: err instanceof Error ? err.message : "Unknown error",
        };
    }
}

// ── Formatting helpers ──────────────────────────────────────────────────

/** Converts stroops (1e-7 XLM units) to a display string with 7 dp. */
export function formatTokens(stroops: bigint, symbol = "YIELD"): string {
    const whole = stroops / 10_000_000n;
    const frac = stroops % 10_000_000n;
    const fracStr = frac.toString().padStart(7, "0").replace(/0+$/, "");
    return fracStr
        ? `${whole.toString()}.${fracStr} ${symbol}`
        : `${whole.toString()} ${symbol}`;
}

/** Returns the percentage of tokens vested out of total allocation (0–100). */
export function vestedPercent(schedule: VestingSchedule): number {
    if (schedule.totalAllocation === 0n) return 0;
    return Number(
        (schedule.vestedAmount * 100n) / schedule.totalAllocation,
    );
}

/** Returns the percentage of tokens already claimed out of total allocation. */
export function claimedPercent(schedule: VestingSchedule): number {
    if (schedule.totalAllocation === 0n) return 0;
    return Number(
        (schedule.claimedAmount * 100n) / schedule.totalAllocation,
    );
}
