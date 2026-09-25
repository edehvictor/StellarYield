/**
 * Deterministic fixture builder for end-to-end transaction scenarios (#1342).
 *
 * Builds one transaction — a deposit, withdraw or zap — as every layer sees
 * it: the client's lifecycle phases with timestamps, the chain's hash, ledger
 * or structured contract error, and the `UserTransaction` row the server
 * persists. The same spec always yields the same scenario: randomness comes
 * from a PRNG seeded by the spec and time from a fixed base, never
 * `Math.random` or the clock. Contract errors are checked against the contract
 * error catalog, so a scenario can only fail with a code the contract really
 * returns. Invalid specs throw a typed `TransactionScenarioError`.
 */
import {
  lookupContractError,
  type ContractErrorNamespace,
  type StructuredScError,
} from "../types/contractPanic";

export type ScenarioAction = "deposit" | "withdraw" | "zap";

export type ScenarioOutcome =
  /** Simulated, signed, submitted and confirmed on-chain. */
  | "confirmed"
  /** Simulation fails with the contract's typed error; nothing is submitted. */
  | "contract_error"
  /** The user declines to sign; nothing is submitted. */
  | "wallet_rejected"
  /** Submitted, but finality was not observed before the poll deadline. */
  | "submission_timeout";

/** Lifecycle phases, matching the client's `TxPhase`. */
export type ScenarioPhase =
  | "building"
  | "simulating"
  | "waiting_for_wallet"
  | "submitting"
  | "polling"
  | "recovering"
  | "success"
  | "failure";

export interface TransactionScenarioSpec {
  /** Non-negative integer; the same seed always models the same wallet. */
  seed: number;
  action: ScenarioAction;
  outcome?: ScenarioOutcome;
  /** Positive integer amount in stroops; derived from the seed when omitted. */
  amountStroops?: string;
  /** Required for `contract_error`: a code from the invoked contract's error enum. */
  contractErrorCode?: number;
  /** ISO timestamp of the first phase; defaults to `SCENARIO_BASE_TIME`. */
  startedAt?: string;
}

/** The persisted `UserTransaction` row (see `server/prisma/schema.prisma`). */
export interface ScenarioServerRecord {
  walletAddress: string;
  vaultId: string;
  action: "DEPOSIT" | "WITHDRAW";
  amount: number;
  shares: number;
  sharePriceAtTx: number;
  txHash: string;
  timestamp: string;
}

export interface TransactionScenario {
  id: string;
  seed: number;
  action: ScenarioAction;
  outcome: ScenarioOutcome;
  walletAddress: string;
  /** Contract the client invokes: the vault, or the zap for `zap`. */
  contractId: string;
  contractNamespace: ContractErrorNamespace;
  amountStroops: string;
  phases: ScenarioPhase[];
  timeline: { phase: ScenarioPhase; at: string }[];
  /** Null when the transaction was never submitted. */
  txHash: string | null;
  /** Ledger the transaction landed in; only set when confirmed. */
  ledger: number | null;
  /** `unknown` after a poll timeout: the transaction may still land. */
  finalStatus: "confirmed" | "failed" | "unknown";
  /** Structured error in the simulation's diagnostic events, for `contract_error`. */
  scError: StructuredScError | null;
  /** Only confirmed transactions are persisted by the server. */
  serverRecord: ScenarioServerRecord | null;
}

// ── Typed errors ───────────────────────────────────────────────────────────

export type TransactionScenarioErrorCode =
  | "SCENARIO_INVALID_SEED"
  | "SCENARIO_UNKNOWN_ACTION"
  | "SCENARIO_UNKNOWN_OUTCOME"
  | "SCENARIO_INVALID_AMOUNT"
  | "SCENARIO_INVALID_START_TIME"
  | "SCENARIO_MISSING_CONTRACT_ERROR"
  | "SCENARIO_UNEXPECTED_CONTRACT_ERROR"
  | "SCENARIO_UNKNOWN_CONTRACT_ERROR";

export class TransactionScenarioError extends Error {
  readonly code: TransactionScenarioErrorCode;

  constructor(code: TransactionScenarioErrorCode, message: string) {
    super(message);
    this.name = "TransactionScenarioError";
    this.code = code;
  }
}

// ── Deterministic primitives ───────────────────────────────────────────────

export const SCENARIO_BASE_TIME = "2026-01-01T00:00:00.000Z";
/** Spacing between consecutive lifecycle phases. */
export const SCENARIO_PHASE_STEP_MS = 1_000;
const SCENARIO_BASE_LEDGER = 1_000_000;

const ACTIONS: readonly ScenarioAction[] = ["deposit", "withdraw", "zap"];
const OUTCOMES: readonly ScenarioOutcome[] = ["confirmed", "contract_error", "wallet_rejected", "submission_timeout"];

/** 32-bit FNV-1a, used to fold a scenario key into a PRNG seed. */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

/** mulberry32: small, fast, and identical on every JS engine. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomBytes(rng: () => number, count: number): number[] {
  return Array.from({ length: count }, () => Math.floor(rng() * 256));
}

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function crc16Xmodem(bytes: readonly number[]): number {
  let crc = 0;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

function base32(bytes: readonly number[]): string {
  let out = "";
  let value = 0;
  let bits = 0;
  for (const byte of bytes) {
    value = ((value << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** Stellar StrKey encoding: version byte + payload + CRC16-XModem (little-endian), base32. */
function encodeStrKey(versionByte: number, payload: readonly number[]): string {
  const data = [versionByte, ...payload];
  const checksum = crc16Xmodem(data);
  return base32([...data, checksum & 0xff, checksum >> 8]);
}

const ACCOUNT_VERSION_BYTE = 6 << 3; // "G…"
const CONTRACT_VERSION_BYTE = 2 << 3; // "C…"

export const SCENARIO_VAULT_CONTRACT_ID = encodeStrKey(CONTRACT_VERSION_BYTE, new Array(32).fill(1));
export const SCENARIO_ZAP_CONTRACT_ID = encodeStrKey(CONTRACT_VERSION_BYTE, new Array(32).fill(2));

const PHASES: Record<ScenarioOutcome, ScenarioPhase[]> = {
  confirmed: ["building", "simulating", "waiting_for_wallet", "submitting", "polling", "success"],
  contract_error: ["building", "simulating", "failure"],
  wallet_rejected: ["building", "simulating", "waiting_for_wallet", "failure"],
  submission_timeout: ["building", "simulating", "waiting_for_wallet", "submitting", "polling", "recovering", "failure"],
};

// ── Builder ────────────────────────────────────────────────────────────────

/** Build the scenario for `spec`. Pure: equal specs yield equal scenarios. */
export function buildTransactionScenario(spec: TransactionScenarioSpec): TransactionScenario {
  const { seed, action } = spec;
  const outcome = spec.outcome ?? "confirmed";

  if (!Number.isSafeInteger(seed) || seed < 0) {
    throw new TransactionScenarioError("SCENARIO_INVALID_SEED", "seed must be a non-negative integer.");
  }
  if (!ACTIONS.includes(action)) {
    throw new TransactionScenarioError("SCENARIO_UNKNOWN_ACTION", `action must be one of ${ACTIONS.join(", ")}.`);
  }
  if (!OUTCOMES.includes(outcome)) {
    throw new TransactionScenarioError("SCENARIO_UNKNOWN_OUTCOME", `outcome must be one of ${OUTCOMES.join(", ")}.`);
  }
  if (spec.amountStroops !== undefined && !/^[1-9]\d*$/.test(spec.amountStroops)) {
    throw new TransactionScenarioError("SCENARIO_INVALID_AMOUNT", "amountStroops must be a positive integer string.");
  }
  const startMs = Date.parse(spec.startedAt ?? SCENARIO_BASE_TIME);
  if (Number.isNaN(startMs)) {
    throw new TransactionScenarioError("SCENARIO_INVALID_START_TIME", "startedAt must be an ISO timestamp.");
  }

  const contractNamespace: ContractErrorNamespace = action === "zap" ? "zap" : "vault";
  let scError: StructuredScError | null = null;
  if (outcome === "contract_error") {
    if (spec.contractErrorCode === undefined) {
      throw new TransactionScenarioError(
        "SCENARIO_MISSING_CONTRACT_ERROR",
        "contract_error scenarios need a contractErrorCode.",
      );
    }
    if (!lookupContractError(contractNamespace, spec.contractErrorCode)) {
      throw new TransactionScenarioError(
        "SCENARIO_UNKNOWN_CONTRACT_ERROR",
        `${spec.contractErrorCode} is not a ${contractNamespace} contract error code.`,
      );
    }
    scError = { type: "sceContract", contractCode: spec.contractErrorCode };
  } else if (spec.contractErrorCode !== undefined) {
    throw new TransactionScenarioError(
      "SCENARIO_UNEXPECTED_CONTRACT_ERROR",
      "contractErrorCode is only valid for contract_error scenarios.",
    );
  }

  // The wallet depends on the seed alone, so one seed models one user across
  // actions; everything else also depends on the action and outcome.
  const walletAddress = encodeStrKey(ACCOUNT_VERSION_BYTE, randomBytes(mulberry32(fnv1a(`wallet:${seed}`)), 32));
  const rng = mulberry32(fnv1a(`${action}:${outcome}:${seed}`));
  const amountStroops = spec.amountStroops ?? String(1_000_000 + Math.floor(rng() * 999_000_000));
  const submitted = outcome === "confirmed" || outcome === "submission_timeout";
  const txHash = submitted
    ? randomBytes(rng, 32)
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("")
    : null;
  const ledger = outcome === "confirmed" ? SCENARIO_BASE_LEDGER + Math.floor(rng() * 100_000) : null;

  const phases = PHASES[outcome];
  const timeline = phases.map((phase, index) => ({
    phase,
    at: new Date(startMs + index * SCENARIO_PHASE_STEP_MS).toISOString(),
  }));

  let serverRecord: ScenarioServerRecord | null = null;
  if (outcome === "confirmed" && txHash) {
    const sharePriceAtTx = 1 + Math.floor(rng() * 500) / 10_000;
    const amount = Number(amountStroops) / 10_000_000;
    serverRecord = {
      walletAddress,
      vaultId: SCENARIO_VAULT_CONTRACT_ID,
      action: action === "withdraw" ? "WITHDRAW" : "DEPOSIT",
      amount,
      shares: Math.round((amount / sharePriceAtTx) * 10_000_000) / 10_000_000,
      sharePriceAtTx,
      txHash,
      timestamp: timeline[timeline.length - 1].at,
    };
  }

  return {
    id: `${action}-${outcome}-${seed}`,
    seed,
    action,
    outcome,
    walletAddress,
    contractId: action === "zap" ? SCENARIO_ZAP_CONTRACT_ID : SCENARIO_VAULT_CONTRACT_ID,
    contractNamespace,
    amountStroops,
    phases,
    timeline,
    txHash,
    ledger,
    finalStatus: outcome === "confirmed" ? "confirmed" : outcome === "submission_timeout" ? "unknown" : "failed",
    scError,
    serverRecord,
  };
}

/** A representative contract error per action, used by the scenario matrix. */
const MATRIX_CONTRACT_ERRORS: Record<ScenarioAction, number> = {
  deposit: 7, // VaultError::Paused
  withdraw: 4, // VaultError::InsufficientShares
  zap: 5, // ZapError::SlippageExceeded
};

/** Every action × outcome combination for one seed, in a stable order. */
export function buildTransactionScenarioMatrix(seed: number): TransactionScenario[] {
  return ACTIONS.flatMap((action) =>
    OUTCOMES.map((outcome) =>
      buildTransactionScenario({
        seed,
        action,
        outcome,
        contractErrorCode: outcome === "contract_error" ? MATRIX_CONTRACT_ERRORS[action] : undefined,
      }),
    ),
  );
}
