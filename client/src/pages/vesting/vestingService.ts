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

const VESTING_CONTRACT_ID =
    import.meta.env.VITE_VESTING_CONTRACT_ID ?? "";

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
    if (!VESTING_CONTRACT_ID) {
        // Contract not configured — return null gracefully (no error trace).
        return null;
    }

    try {
        const server = new StellarSdk.rpc.Server(RPC_URL);
        const contract = new StellarSdk.Contract(VESTING_CONTRACT_ID);

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

        const val = StellarSdk.scValToNative(result.result.retval) as {
            total_allocation: bigint;
            vested_amount: bigint;
            claimed_amount: bigint;
            cliff_timestamp: bigint;
            end_timestamp: bigint;
            next_unlock_timestamp: bigint;
            start_timestamp: bigint;
        };

        const claimable =
            val.vested_amount - val.claimed_amount > 0n
                ? val.vested_amount - val.claimed_amount
                : 0n;

        return {
            totalAllocation: val.total_allocation,
            vestedAmount: val.vested_amount,
            claimedAmount: val.claimed_amount,
            claimableAmount: claimable,
            cliffTimestamp: Number(val.cliff_timestamp),
            endTimestamp: Number(val.end_timestamp),
            nextUnlockTimestamp: Number(val.next_unlock_timestamp),
            startTimestamp: Number(val.start_timestamp),
        };
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
    if (!VESTING_CONTRACT_ID) {
        return { success: false, error: "Vesting contract is not configured." };
    }

    try {
        const server = new StellarSdk.rpc.Server(RPC_URL);
        const contract = new StellarSdk.Contract(VESTING_CONTRACT_ID);

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
