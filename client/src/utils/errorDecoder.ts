/**
 * errorDecoder.ts
 *
 * Utility for parsing failed Soroban / Horizon transaction results and
 * translating raw contract error codes into human-readable messages
 * with suggested fixes.
 *
 * @module errorDecoder
 */

// ── Error Dictionary ────────────────────────────────────────────────────

/**
 * A decoded, user-friendly representation of a failed Soroban transaction.
 */
export interface DecodedError {
    /** Short, human-readable title for the modal heading. */
    title: string;
    /** Friendly explanation shown to the end user. */
    message: string;
    /** Actionable suggestion to help the user recover. */
    suggestion: string;
    /** Raw developer log preserved for the expandable section. */
    raw: string;
    /** Numeric contract error code when available. */
    code?: number;
}

/** Maps known contract error codes to user-facing messages. */
const CONTRACT_ERROR_MAP: Record<
    number,
    Omit<DecodedError, "raw" | "code">
> = {
    // ── YieldVault ──────────────────────────────────────────────────────
    1: {
        title: "Contract Not Initialized",
        message: "The vault contract has not been set up yet.",
        suggestion: "Please contact support — the contract admin must call initialize first.",
    },
    2: {
        title: "Already Initialized",
        message: "The vault has already been configured.",
        suggestion: "No action needed. Try refreshing the page.",
    },
    3: {
        title: "Zero Amount",
        message: "You must deposit or withdraw an amount greater than zero.",
        suggestion: "Enter a positive token amount and try again.",
    },
    4: {
        title: "Insufficient Shares",
        message: "You don't have enough vault shares to complete this withdrawal.",
        suggestion: "Reduce the withdrawal amount or wait for more shares to accrue.",
    },
    5: {
        title: "Unauthorised",
        message: "Your wallet is not permitted to perform this action.",
        suggestion: "Make sure you are connected with the correct wallet address.",
    },
    6: {
        title: "Zero Supply",
        message: "The vault has no shares in circulation, so the ratio cannot be calculated.",
        suggestion: "Deposit funds into the vault first to establish the share ratio.",
    },
    7: {
        title: "Vault Paused",
        message: "The vault is currently paused for maintenance.",
        suggestion: "Check the protocol announcements for an estimated resume time.",
    },
    8: {
        title: "Timelock Active",
        message: "This administrative action is still within its time-lock period.",
        suggestion: "Wait for the timelock to expire before retrying.",
    },
    9: {
        title: "Invalid Oracle Price",
        message: "The on-chain oracle returned an invalid or stale price.",
        suggestion: "Try again after a few seconds to allow the oracle to update.",
    },
    10: {
        title: "Slippage Exceeded",
        message: "The price moved too much during your swap. Your slippage tolerance was exceeded.",
        suggestion: "Increase your slippage tolerance or try again when markets are calmer.",
    },
    // ── Vesting ────────────────────────────────────────────────────────
    1001: {
        title: "No Vesting Schedule",
        message: "This wallet does not have an active vesting schedule.",
        suggestion: "Confirm you are using the correct wallet address for your vesting allocation.",
    },
    1002: {
        title: "Nothing to Claim",
        message: "No tokens have vested yet. The cliff period has not been reached.",
        suggestion: "Check the vesting schedule for your next unlock date and try again later.",
    },
    1003: {
        title: "Already Claimed",
        message: "All currently vested tokens have already been claimed.",
        suggestion: "Wait for the next linear-unlock tick to claim additional tokens.",
    },
    // ── Donations ──────────────────────────────────────────────────────
    2001: {
        title: "Invalid Donation Percentage",
        message: "The yield split percentage must be between 0 and 100.",
        suggestion: "Enter a valid percentage between 0 and 100.",
    },
    2002: {
        title: "Charity Not Whitelisted",
        message: "The selected charity address is not on the protocol's whitelist.",
        suggestion: "Choose a charity from the approved list in the Yield for Good panel.",
    },
    // ── Intent Swap ────────────────────────────────────────────────────
    3001: {
        title: "Insufficient Balance for Swap",
        message: "You don't have enough tokens in your wallet to complete this swap.",
        suggestion: "Add more funds or reduce the swap amount.",
    },
    3002: {
        title: "Order Expired",
        message: "Your swap intent expired before it could be matched.",
        suggestion: "Submit a new swap order with an updated expiry.",
    },
};

// ── XDR / RPC Error Parsing ─────────────────────────────────────────────

/**
 * Attempts to extract a numeric contract error code from various error
 * result formats returned by Soroban RPC or Horizon.
 *
 * Handles:
 *  - `Error(Contract, #N)` — Soroban SDK diagnostic string
 *  - `contract_code:N`     — custom label used by some indexers
 *  - `Error(N)`            — simplified in-house format
 *  - JSON `{code: N}`      — structured error objects
 *
 * @param raw - Raw error string or serialised object from the transaction result.
 * @returns The parsed error code number, or `undefined` if none found.
 */
export function extractErrorCode(raw: string): number | undefined {
    if (!raw) return undefined;

    // Soroban SDK format: "Error(Contract, #1001)" or "WasmVm error: Error(1001)"
    const sorobanMatch = /Error\s*\(\s*(?:Contract\s*,\s*)?#?(\d+)\s*\)/i.exec(raw);
    if (sorobanMatch) return parseInt(sorobanMatch[1], 10);

    // Indexer / custom label: "contract_code:1001"
    const labelMatch = /contract_code\s*:\s*(\d+)/i.exec(raw);
    if (labelMatch) return parseInt(labelMatch[1], 10);

    // JSON structured payload
    try {
        const parsed = JSON.parse(raw) as unknown;
        if (
            parsed !== null &&
            typeof parsed === "object" &&
            "code" in parsed &&
            typeof (parsed as Record<string, unknown>).code === "number"
        ) {
            return (parsed as Record<string, number>).code;
        }
    } catch {
        // not JSON — continue to next strategy
    }

    return undefined;
}

/**
 * Decodes a failed Soroban transaction result (raw XDR string, RPC error
 * message, or serialised object) into a `DecodedError` suitable for
 * display in the Transaction Failed modal.
 *
 * Always returns a non-throwing result regardless of input format.
 *
 * @param raw - The raw error string from Horizon or Soroban RPC.
 * @returns A `DecodedError` with user-friendly copy and the original raw string.
 */
export function decodeTransactionError(raw: string): DecodedError {
    const safeRaw = typeof raw === "string" ? raw : JSON.stringify(raw);
    const code = extractErrorCode(safeRaw);

    if (code !== undefined && code in CONTRACT_ERROR_MAP) {
        return {
            ...CONTRACT_ERROR_MAP[code],
            code,
            raw: safeRaw,
        };
    }

    // Network-level or wallet-rejection checks
    if (/user declined|user rejected|cancelled/i.test(safeRaw)) {
        return {
            title: "Transaction Cancelled",
            message: "You rejected the transaction in your wallet.",
            suggestion: "Approve the transaction in Freighter if you want to proceed.",
            raw: safeRaw,
        };
    }

    if (/insufficient funds|balance/i.test(safeRaw)) {
        return {
            title: "Insufficient Funds",
            message: "Your wallet does not have enough XLM to cover the fees.",
            suggestion: "Add at least 2 XLM to your account and try again.",
            raw: safeRaw,
        };
    }

    if (/timeout|network|fetch/i.test(safeRaw)) {
        return {
            title: "Network Error",
            message: "Could not reach the Stellar network.",
            suggestion: "Check your internet connection and try again.",
            raw: safeRaw,
        };
    }

    // Generic fallback
    return {
        title: "Transaction Failed",
        message: "An unexpected error occurred while processing your transaction.",
        suggestion: "Expand the developer log below and share it with support.",
        raw: safeRaw,
        code,
    };
}
