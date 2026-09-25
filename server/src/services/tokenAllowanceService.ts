/**
 * Token allowance checks with typed failures (#1395).
 *
 * Reads the SEP-41 `allowance(owner, spender)` view through the shared
 * read-only simulation helper and reduces every outcome — sufficient,
 * insufficient, unreachable, timed out, or unsupported — to a typed result.
 * Raw provider/RPC text never crosses this boundary: contract-level failures
 * are decoded from their structured `ScError` (see `shared/types/contractPanic`)
 * and everything else becomes a stable `TokenAllowanceError` code.
 *
 * The functions here never throw, so route handlers can render a deterministic
 * failure state instead of a try/catch around provider output.
 */
import { addressArg, simulateReadOnlyCall } from "./sorobanReader";
import {
  evaluateAllowance,
  mapAllowanceFailure,
  type TokenAllowanceError,
} from "../../../shared/types/tokenAllowance";

export interface TokenAllowanceRequest {
  /** SEP-41 token contract whose allowance is being read. */
  tokenContractId: string;
  /** Address that owns the tokens. */
  owner: string;
  /** Address approved to spend them (the vault/zap contract). */
  spender: string;
}

export type TokenAllowanceOutcome =
  | {
      ok: true;
      allowance: bigint;
      required?: bigint;
      sufficient: boolean;
      shortfall: bigint;
    }
  | { ok: false; error: TokenAllowanceError };

/**
 * Parse a native-decoded `allowance` return value. Only non-negative integers
 * are valid; anything else is treated as a failed read rather than coerced.
 */
export function parseAllowanceValue(value: unknown): bigint | null {
  if (typeof value === "bigint") {
    return value >= 0n ? value : null;
  }
  if (typeof value === "number") {
    return Number.isInteger(value) && value >= 0 ? BigInt(value) : null;
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    return BigInt(value);
  }
  return null;
}

/**
 * Read the current allowance for `owner`/`spender` without comparing it to an
 * amount. Never throws.
 */
export async function readTokenAllowance(
  request: TokenAllowanceRequest,
): Promise<TokenAllowanceOutcome> {
  let outcome: Awaited<ReturnType<typeof simulateReadOnlyCall<unknown>>>;
  try {
    outcome = await simulateReadOnlyCall<unknown>(
      request.tokenContractId,
      "allowance",
      [addressArg(request.owner), addressArg(request.spender)],
    );
  } catch {
    // `simulateReadOnlyCall` is documented as non-throwing, but a malformed
    // address or an unexpected SDK failure must still resolve to a typed error.
    return { ok: false, error: mapAllowanceFailure({ kind: "read_failed" }) };
  }

  if (outcome.ok) {
    const allowance = parseAllowanceValue(outcome.value);
    if (allowance === null) {
      return { ok: false, error: mapAllowanceFailure({ kind: "read_failed" }) };
    }
    return { ok: true, allowance, sufficient: true, shortfall: 0n };
  }

  if (outcome.reason === "timeout") {
    return { ok: false, error: mapAllowanceFailure({ kind: "read_timeout" }) };
  }

  if (outcome.reason === "contract_error") {
    // A missing `allowance` entry point traps the Wasm VM, which decodes to
    // CONTRACT_TRAPPED — that is our signal the token is not SEP-41 compliant.
    if (outcome.panic?.code === "CONTRACT_TRAPPED") {
      return {
        ok: false,
        error: mapAllowanceFailure({
          kind: "unsupported_token",
          tokenId: request.tokenContractId,
        }),
      };
    }
    return {
      ok: false,
      error: mapAllowanceFailure({ kind: "read_failed", panic: outcome.panic }),
    };
  }

  return { ok: false, error: mapAllowanceFailure({ kind: "read_failed" }) };
}

/**
 * Check that `spender` is approved to move at least `required` tokens of
 * `tokenContractId` on behalf of `owner`.
 *
 * Returns `{ ok: true }` with the (possibly short) allowance details, or
 * `{ ok: false, error }` carrying a typed `TokenAllowanceError`. A non-positive
 * `required` is rejected as an invalid amount rather than silently passing.
 */
export async function checkTokenAllowance(
  request: TokenAllowanceRequest,
  required: bigint,
): Promise<TokenAllowanceOutcome> {
  if (required <= 0n) {
    return {
      ok: false,
      error: mapAllowanceFailure({ kind: "invalid_amount", reason: "non_positive" }),
    };
  }

  const read = await readTokenAllowance(request);
  if (!read.ok) {
    return read;
  }

  const { sufficient, shortfall } = evaluateAllowance(read.allowance, required);
  if (!sufficient) {
    return {
      ok: false,
      error: mapAllowanceFailure({
        kind: "insufficient_allowance",
        required,
        available: read.allowance,
      }),
    };
  }

  return {
    ok: true,
    allowance: read.allowance,
    required,
    sufficient: true,
    shortfall,
  };
}
