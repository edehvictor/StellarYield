import { Router, Request, Response } from "express";

const router = Router();

// ── Types ──────────────────────────────────────────────────────────────────

export type VaultEventType = "deposit" | "withdrawal" | "reward" | "rebalance";

export interface VaultActivityCursor {
  ledger: number;
  txHash: string;
  eventIndex: number;
}

export interface VaultActivityEvent {
  id: string;
  vaultId: string;
  asset: string;
  eventType: VaultEventType;
  ledger: number;
  txHash: string;
  eventIndex: number;
  amount: string;
  wallet: string;
  timestamp: string;
}

export interface VaultActivityPage {
  events: VaultActivityEvent[];
  nextCursor: string | null;
  prevCursor: string | null;
  total: number;
  pageSize: number;
}

export interface VaultActivityFilters {
  vaultId?: string;
  asset?: string;
  eventType?: VaultEventType;
  ledgerFrom?: number;
  ledgerTo?: number;
}

// ── Constants ──────────────────────────────────────────────────────────────

const VALID_EVENT_TYPES: VaultEventType[] = ["deposit", "withdrawal", "reward", "rebalance"];
const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 25;

// ── Cursor encoding/decoding ───────────────────────────────────────────────

export function encodeCursor(cursor: VaultActivityCursor): string {
  const payload = `${cursor.ledger}:${cursor.txHash}:${cursor.eventIndex}`;
  return Buffer.from(payload, "utf8").toString("base64url");
}

export function decodeCursor(encoded: string): VaultActivityCursor {
  let raw: string;
  try {
    raw = Buffer.from(encoded, "base64url").toString("utf8");
  } catch {
    throw new CursorDecodeError(`Cannot base64url-decode cursor`);
  }

  const parts = raw.split(":");
  if (parts.length !== 3) {
    throw new CursorDecodeError(`Cursor must encode exactly 3 fields, got ${parts.length}`);
  }

  const [ledgerRaw, txHash, eventIndexRaw] = parts;
  const ledger = parseInt(ledgerRaw, 10);
  const eventIndex = parseInt(eventIndexRaw, 10);

  if (!Number.isInteger(ledger) || ledger < 0) {
    throw new CursorDecodeError(`Cursor ledger field is not a valid non-negative integer`);
  }
  if (!txHash || !/^[A-Fa-f0-9]{64}$/.test(txHash)) {
    throw new CursorDecodeError(`Cursor txHash field must be a 64-char hex string`);
  }
  if (!Number.isInteger(eventIndex) || eventIndex < 0) {
    throw new CursorDecodeError(`Cursor eventIndex field is not a valid non-negative integer`);
  }

  return { ledger, txHash, eventIndex };
}

export class CursorDecodeError extends Error {
  constructor(detail: string) {
    super(`Invalid pagination cursor: ${detail}`);
    this.name = "CursorDecodeError";
  }
}

// ── Stable sort comparator ────────────────────────────────────────────────

export function compareEvents(a: VaultActivityEvent, b: VaultActivityEvent): number {
  if (a.ledger !== b.ledger) return a.ledger - b.ledger;
  if (a.txHash !== b.txHash) return a.txHash.localeCompare(b.txHash, "en", { sensitivity: "case" });
  return a.eventIndex - b.eventIndex;
}

export function cursorPositionOf(event: VaultActivityEvent): VaultActivityCursor {
  return { ledger: event.ledger, txHash: event.txHash, eventIndex: event.eventIndex };
}

function isCursorAfter(event: VaultActivityEvent, cursor: VaultActivityCursor): boolean {
  if (event.ledger !== cursor.ledger) return event.ledger > cursor.ledger;
  if (event.txHash !== cursor.txHash) {
    return event.txHash.localeCompare(cursor.txHash, "en", { sensitivity: "case" }) > 0;
  }
  return event.eventIndex > cursor.eventIndex;
}

// ── Filter application ────────────────────────────────────────────────────

export function applyFilters(
  events: VaultActivityEvent[],
  filters: VaultActivityFilters,
): VaultActivityEvent[] {
  return events.filter((e) => {
    if (filters.vaultId && e.vaultId !== filters.vaultId) return false;
    if (filters.asset && e.asset !== filters.asset) return false;
    if (filters.eventType && e.eventType !== filters.eventType) return false;
    if (filters.ledgerFrom !== undefined && e.ledger < filters.ledgerFrom) return false;
    if (filters.ledgerTo !== undefined && e.ledger > filters.ledgerTo) return false;
    return true;
  });
}

// ── Pagination engine ─────────────────────────────────────────────────────

export interface PaginateOptions {
  events: VaultActivityEvent[];
  filters: VaultActivityFilters;
  afterCursor?: VaultActivityCursor;
  beforeCursor?: VaultActivityCursor;
  pageSize: number;
}

export function paginateVaultActivity(opts: PaginateOptions): VaultActivityPage {
  const { pageSize } = opts;
  const filtered = applyFilters(opts.events, opts.filters);
  const sorted = [...filtered].sort(compareEvents);

  let slice = sorted;
  if (opts.afterCursor) {
    const ac = opts.afterCursor;
    slice = sorted.filter((e) => isCursorAfter(e, ac));
  } else if (opts.beforeCursor) {
    const bc = opts.beforeCursor;
    slice = sorted.filter((e) => !isCursorAfter(e, bc) && (
      e.ledger !== bc.ledger || e.txHash !== bc.txHash || e.eventIndex !== bc.eventIndex
    ));
  }

  const page = slice.slice(0, pageSize);

  const nextCursor =
    slice.length > pageSize && page.length > 0
      ? encodeCursor(cursorPositionOf(page[page.length - 1]))
      : null;

  const prevCursor = opts.afterCursor && page.length > 0
    ? encodeCursor(cursorPositionOf(page[0]))
    : null;

  return {
    events: page,
    nextCursor,
    prevCursor,
    total: filtered.length,
    pageSize,
  };
}

// ── Route handler ─────────────────────────────────────────────────────────

router.get("/", (req: Request, res: Response) => {
  const rawPageSize = parseInt(String(req.query.pageSize ?? DEFAULT_PAGE_SIZE), 10);
  const pageSize = Number.isNaN(rawPageSize)
    ? DEFAULT_PAGE_SIZE
    : Math.min(Math.max(1, rawPageSize), MAX_PAGE_SIZE);

  const filters: VaultActivityFilters = {};
  if (req.query.vaultId) filters.vaultId = String(req.query.vaultId);
  if (req.query.asset) filters.asset = String(req.query.asset);
  if (req.query.eventType) {
    const et = String(req.query.eventType);
    if (!VALID_EVENT_TYPES.includes(et as VaultEventType)) {
      res.status(400).json({
        error: "INVALID_FILTER",
        field: "eventType",
        message: `eventType must be one of: ${VALID_EVENT_TYPES.join(", ")}`,
      });
      return;
    }
    filters.eventType = et as VaultEventType;
  }
  if (req.query.ledgerFrom) {
    const lf = parseInt(String(req.query.ledgerFrom), 10);
    if (Number.isNaN(lf) || lf < 0) {
      res.status(400).json({ error: "INVALID_FILTER", field: "ledgerFrom", message: "ledgerFrom must be a non-negative integer" });
      return;
    }
    filters.ledgerFrom = lf;
  }
  if (req.query.ledgerTo) {
    const lt = parseInt(String(req.query.ledgerTo), 10);
    if (Number.isNaN(lt) || lt < 0) {
      res.status(400).json({ error: "INVALID_FILTER", field: "ledgerTo", message: "ledgerTo must be a non-negative integer" });
      return;
    }
    filters.ledgerTo = lt;
  }
  if (filters.ledgerFrom !== undefined && filters.ledgerTo !== undefined && filters.ledgerFrom > filters.ledgerTo) {
    res.status(400).json({ error: "INVALID_FILTER", field: "ledgerFrom", message: "ledgerFrom must not exceed ledgerTo" });
    return;
  }

  let afterCursor: VaultActivityCursor | undefined;
  let beforeCursor: VaultActivityCursor | undefined;

  if (req.query.after) {
    try {
      afterCursor = decodeCursor(String(req.query.after));
    } catch {
      res.status(400).json({ error: "INVALID_CURSOR", field: "after", message: "Cursor is malformed or tampered" });
      return;
    }
  }
  if (req.query.before) {
    try {
      beforeCursor = decodeCursor(String(req.query.before));
    } catch {
      res.status(400).json({ error: "INVALID_CURSOR", field: "before", message: "Cursor is malformed or tampered" });
      return;
    }
  }
  if (afterCursor && beforeCursor) {
    res.status(400).json({ error: "INVALID_CURSOR", message: "Provide at most one of 'after' or 'before', not both" });
    return;
  }

  // In production this data comes from the database; the empty array here is
  // the integration point that route tests will replace with fixtures.
  const allEvents: VaultActivityEvent[] = (req as any)._testEvents ?? [];

  const page = paginateVaultActivity({ events: allEvents, filters, afterCursor, beforeCursor, pageSize });
  res.json(page);
});

export default router;
