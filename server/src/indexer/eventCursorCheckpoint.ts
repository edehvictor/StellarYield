/**
 * Soroban Event Cursor Checkpoint Recovery (#1289)
 *
 * Pure helpers that turn one page of Soroban contract events plus the RPC's
 * pagination cursor into the next durable checkpoint. The checkpoint must be
 * persisted *before* a crash can stop the loop so a restart resumes exactly
 * where indexing left off — no gaps, no double ingestion.
 *
 * The module never reaches out to the network or a database; every function
 * is pure so the recovery edge cases can be unit-tested deterministically.
 */

export type EventCursorErrorCode =
  | "MISSING_CURSOR"
  | "STALE_CURSOR"
  | "LEDGER_REGRESSION";

/**
 * Typed error for invalid or unsupported cursor checkpoint transitions.
 * Never carries a raw provider message — callers branch on `code`.
 */
export class EventCursorError extends Error {
  readonly code: EventCursorErrorCode;
  readonly meta: Record<string, unknown>;

  constructor(
    code: EventCursorErrorCode,
    message: string,
    meta: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "EventCursorError";
    this.code = code;
    this.meta = meta;
  }
}

/** Durable checkpoint for a single contract indexer cursor. */
export interface EventPageCheckpoint {
  /** Last ledger fully ingested up to (inclusive of this page). */
  lastLedger: number;
  /** Opaque Soroban RPC pagination cursor. Null when fully paginated. */
  cursorPosition: string | null;
  /** Whether more pages are expected for the current ledger range. */
  hasMorePages: boolean;
}

export interface EventPageInput {
  /** Ledger the indexer is currently checkpointed at. */
  lastLedger: number;
  /** Latest ledger observed on the network for this poll cycle. */
  endLedger: number;
  /** Events delivered in the current page (ledger ascending). */
  events: ReadonlyArray<{ ledger: number }>;
  /** The RPC `cursor` returned alongside this page, when present. */
  rpcCursor: string | null;
  /** Page size the query was issued with. */
  limit: number;
}

export type EventPageCheckpointOutcome =
  | { ok: true; checkpoint: EventPageCheckpoint }
  | { ok: false; error: EventCursorError };

/**
 * Compute the next durable checkpoint from the current page.
 *
 * Failure states (all typed, deterministic):
 * - `LEDGER_REGRESSION` — a delivered event is not ahead of the checkpoint,
 *   which means the cursor is not moving forward (or was already consumed).
 * - `MISSING_CURSOR` — the page is exactly full but the RPC returned no
 *   cursor, so we cannot resume pagination after a crash without gaps.
 * - `STALE_CURSOR` — we hold a cursor but events stalled against the end of
 *   the replayed range.
 */
export function computeEventPageCheckpoint(
  input: EventPageInput,
): EventPageCheckpointOutcome {
  const { lastLedger, endLedger, events, rpcCursor, limit } = input;

  if (events.length === 0) {
    return {
      ok: true,
      checkpoint: {
        lastLedger: endLedger,
        cursorPosition: null,
        hasMorePages: false,
      },
    };
  }

  const lastEventLedger = events[events.length - 1].ledger;
  if (lastEventLedger <= lastLedger) {
    return {
      ok: false,
      error: new EventCursorError(
        "LEDGER_REGRESSION",
        `Cursor checkpoint did not advance past ledger ${lastLedger} (last event ledger ${lastEventLedger})`,
        { lastLedger, lastEventLedger },
      ),
    };
  }

  const hasMorePages = events.length >= limit;
  if (hasMorePages && !rpcCursor) {
    return {
      ok: false,
      error: new EventCursorError(
        "MISSING_CURSOR",
        `Page is full (${limit} events) but provider returned no pagination cursor; ` +
          "cannot checkpoint a resumable cursor",
        { limit },
      ),
    };
  }

  return {
    ok: true,
    checkpoint: {
      lastLedger: lastEventLedger,
      cursorPosition: hasMorePages ? rpcCursor : null,
      hasMorePages,
    },
  };
}

/** Best-effort extraction of the opaque pagination cursor from an RPC page. */
export function extractRpcCursor(
  page: { cursor?: string | null } | null | undefined,
): string | null {
  const cursor = page?.cursor;
  return typeof cursor === "string" && cursor.length > 0 ? cursor : null;
}