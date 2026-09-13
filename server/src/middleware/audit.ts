import { Request, Response, NextFunction } from "express";
import crypto from "crypto";
import fs from "fs/promises";
import path from "path";

/**
 * Audit Trail System for Admin Dashboard
 * Provides immutable, cryptographically signed logging of all admin actions
 */

export interface AuditLogEntry {
  id: string;
  timestamp: string;
  userId: string;
  userEmail?: string;
  action: string;
  resource: string;
  resourceId?: string;
  method: string;
  endpoint: string;
  status: number;
  changes?: Record<string, unknown>;
  ipAddress: string;
  userAgent: string;
  previousHash: string;
  hash: string;
  signature?: string;
  /**
   * The human-readable confirmation text the actor reviewed before
   * submitting.  Only present on ADMIN_ACTION_CONFIRMED entries.
   */
  confirmationText?: string;
  /**
   * True when the actor explicitly cancelled the action without
   * submitting.  Only present on ADMIN_ACTION_CANCELLED entries.
   * When true, no `changes` are recorded.
   */
  cancelled?: boolean;
}

export interface AuditContext {
  id?: string;
  timestamp?: string;
  userId?: string;
  userEmail?: string;
  action?: string;
  resource?: string;
  resourceId?: string;
  changes?: Record<string, unknown>;
  confirmationText?: string;
  cancelled?: boolean;
}

// ── Admin-confirmation record types ───────────────────────────────────────

export interface AdminConfirmationInput {
  /** Actor's user id (falls back to ANONYMOUS) */
  actorId: string;
  actorEmail?: string;
  /** Logical action type, e.g. "UPDATE_TREASURY_FEE" */
  actionType: string;
  /** Resource category, e.g. "TREASURY", "PROTOCOL", "CAMPAIGN", "GOVERNANCE" */
  resource: string;
  /** Specific resource id, e.g. a vault id or campaign id */
  resourceId?: string;
  /** The text the actor read and confirmed in the UI */
  confirmationText: string;
  /** The delta / payload that was applied */
  changes?: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
}

// In-memory audit log (in production, use a database)
let auditLog: AuditLogEntry[] = [];
let previousHash = "";

// Audit log file path for persistence
const AUDIT_LOG_DIR = process.env.AUDIT_LOG_DIR || "./audit-logs";
const AUDIT_LOG_FILE = path.join(AUDIT_LOG_DIR, "audit-trail.jsonl");

/**
 * Reset in-memory state (used in tests)
 */
export function resetAuditLog(): void {
  auditLog = [];
  previousHash = crypto.createHash("sha256").update("GENESIS").digest("hex");
}

/**
 * Initialize audit log directory and load existing logs
 */
export async function initializeAuditLog(): Promise<void> {
  try {
    await fs.mkdir(AUDIT_LOG_DIR, { recursive: true });

    // Load existing logs to get the previous hash
    try {
      const content = await fs.readFile(AUDIT_LOG_FILE, "utf-8");
      const lines = content
        .trim()
        .split("\n")
        .filter((line) => line);
      if (lines.length > 0) {
        const lastEntry = JSON.parse(lines[lines.length - 1]);
        previousHash = lastEntry.hash;
        auditLog = lines.map((line) => JSON.parse(line));
      }
    } catch {
      // File doesn't exist yet, start fresh
      previousHash = crypto
        .createHash("sha256")
        .update("GENESIS")
        .digest("hex");
    }
  } catch (error) {
    console.error("Failed to initialize audit log:", error);
    throw error;
  }
}

/**
 * Generate SHA-256 hash for audit entry
 */
function generateHash(
  entry: Omit<AuditLogEntry, "hash" | "signature">,
): string {
  const data = JSON.stringify({
    id: entry.id,
    timestamp: entry.timestamp,
    userId: entry.userId,
    action: entry.action,
    resource: entry.resource,
    method: entry.method,
    endpoint: entry.endpoint,
    status: entry.status,
    changes: entry.changes,
    ipAddress: entry.ipAddress,
    previousHash: entry.previousHash,
  });

  return crypto.createHash("sha256").update(data).digest("hex");
}

/**
 * Generate cryptographic signature for audit entry
 */
function generateSignature(hash: string, privateKey?: string): string {
  const key = privateKey || process.env.AUDIT_SIGNING_KEY || "default-key";
  return crypto.createHmac("sha256", key).update(hash).digest("hex");
}

/**
 * Extract user information from request
 */
function extractUserInfo(req: Request): {
  userId?: string;
  userEmail?: string;
} {
  // Assuming user info is attached to request by auth middleware
  const user = (req as unknown as Record<string, unknown>).user as
    { id?: string; email?: string } | undefined;
  return {
    userId: user?.id || "ANONYMOUS",
    userEmail: user?.email,
  };
}

/**
 * Extract client IP address
 */
function getClientIp(req: Request): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string") {
    return forwarded.split(",")[0].trim();
  }
  return req.socket?.remoteAddress || "UNKNOWN";
}

/**
 * Create and persist an audit log entry
 */
export async function createAuditEntry(
  req: Request,
  res: Response,
  context: AuditContext,
): Promise<AuditLogEntry> {
  const { userId, userEmail } = extractUserInfo(req);
  const id = context.id ?? crypto.randomUUID();
  const timestamp = context.timestamp ?? new Date().toISOString();

  const entryData: Omit<AuditLogEntry, "hash" | "signature"> = {
    id,
    timestamp,
    userId: context.userId ?? userId ?? "ANONYMOUS",
    userEmail: context.userEmail || userEmail,
    action: context.action || "UNKNOWN",
    resource: context.resource || "UNKNOWN",
    resourceId: context.resourceId,
    method: req.method,
    endpoint: req.path,
    status: res.statusCode,
    changes: context.changes,
    ipAddress: getClientIp(req),
    userAgent: req.headers["user-agent"] || "UNKNOWN",
    previousHash,
    ...(context.confirmationText !== undefined && {
      confirmationText: context.confirmationText,
    }),
    ...(context.cancelled !== undefined && { cancelled: context.cancelled }),
  };

  const hash = generateHash(entryData);
  const signature = generateSignature(hash);

  const entry: AuditLogEntry = {
    ...entryData,
    hash,
    signature,
  };

  // Store in memory
  auditLog.push(entry);
  previousHash = hash;

  // Persist to file
  try {
    await fs.appendFile(AUDIT_LOG_FILE, JSON.stringify(entry) + "\n");
  } catch (error) {
    console.error("Failed to persist audit log entry:", error);
    // Don't throw - log should not block operations
  }

  return entry;
}

/**
 * Verify audit log entry integrity
 */
export function verifyAuditEntry(entry: AuditLogEntry): boolean {
  const { hash, signature, ...entryData } = entry;

  // Verify hash
  const calculatedHash = generateHash(
    entryData as Omit<AuditLogEntry, "hash" | "signature">,
  );
  if (calculatedHash !== hash) {
    return false;
  }

  // Verify signature
  const calculatedSignature = generateSignature(hash);
  if (calculatedSignature !== signature) {
    return false;
  }

  return true;
}

/**
 * Retrieve audit logs with optional filtering and cursor pagination.
 *
 * Ordering contract:
 * - Primary: timestamp descending (newest first)
 * - Secondary: id ascending to break ties when timestamps are equal
 *
 * Cursor pagination contract:
 * - On entry, `cursor` is an opaque string previously returned as `nextCursor`.
 * - When `cursor` is set, results exclude the cursor entry and everything before it.
 * - `nextCursor` is the last returned entry's id, or `null` when there are no more pages.
 * - No record is ever skipped or duplicated across successive pages assuming caller
 *   passes the returned `nextCursor` unchanged.
 */
export async function getAuditLogs(filters?: {
  userId?: string;
  action?: string;
  resource?: string;
  startDate?: string;
  endDate?: string;
  limit?: number;
  cursor?: string;
}): Promise<AuditLogEntry[]> {
  let results = [...auditLog];

  if (filters?.userId) {
    results = results.filter((entry) => entry.userId === filters.userId);
  }

  if (filters?.action) {
    results = results.filter((entry) => entry.action === filters.action);
  }

  if (filters?.resource) {
    results = results.filter((entry) => entry.resource === filters.resource);
  }

  if (filters?.startDate) {
    const startTime = new Date(filters.startDate).getTime();
    results = results.filter(
      (entry) => new Date(entry.timestamp).getTime() >= startTime,
    );
  }

  if (filters?.endDate) {
    const endTime = new Date(filters.endDate).getTime();
    results = results.filter(
      (entry) => new Date(entry.timestamp).getTime() <= endTime,
    );
  }

  // Stable ordering: newest first; tie-break by id ascending so equal timestamps
  // produce a deterministic sequence.
  results.sort((a, b) => {
    const ta =
      new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
    if (ta !== 0) return ta;
    if (a.id < b.id) return -1;
    if (a.id > b.id) return 1;
    return 0;
  });

  // Apply cursor: find the cursor entry and start after it. If not found, fall
  // back to the first page so requests with stale cursors degrade safely.
  let startIndex = 0;
  if (filters?.cursor) {
    const idx = results.findIndex((entry) => entry.id === filters.cursor);
    if (idx >= 0) {
      startIndex = idx + 1;
    }
  }

  const limit = filters?.limit || 100;
  return results.slice(startIndex, startIndex + limit);
}

/**
 * Verify audit trail integrity (chain of hashes)
 */
export function verifyAuditTrailIntegrity(entries: AuditLogEntry[]): {
  isValid: boolean;
  invalidEntries: string[];
} {
  const invalidEntries: string[] = [];
  let expectedPreviousHash = crypto
    .createHash("sha256")
    .update("GENESIS")
    .digest("hex");

  for (const entry of entries) {
    // Verify entry signature
    if (!verifyAuditEntry(entry)) {
      invalidEntries.push(entry.id);
      continue;
    }

    // Verify hash chain
    if (entry.previousHash !== expectedPreviousHash) {
      invalidEntries.push(entry.id);
    }

    expectedPreviousHash = entry.hash;
  }

  return {
    isValid: invalidEntries.length === 0,
    invalidEntries,
  };
}

/**
 * Express middleware for automatic audit logging
 */
export function auditMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  // Store original send function
  const originalSend = res.send;

  // Override send to capture response
  res.send = function (data: unknown) {
    if (res.headersSent) {
      return this;
    }

    // Attach audit context to request for later use
    const auditContext = (req as unknown as Record<string, unknown>)
      .auditContext as AuditContext | undefined;

    if (auditContext) {
      // Create audit entry asynchronously
      createAuditEntry(req, res, auditContext).catch((error) => {
        console.error("Failed to create audit entry:", error);
      });
    }

    // Call original send
    return originalSend.call(this, data);
  };

  next();
}

/**
 * Helper function to attach audit context to request
 */
export function setAuditContext(req: Request, context: AuditContext): void {
  (req as unknown as Record<string, unknown>).auditContext = context;
}

/**
 * Export audit logs to CSV format
 */
export async function exportAuditLogsToCSV(
  filters?: Parameters<typeof getAuditLogs>[0],
): Promise<string> {
  const entries = await getAuditLogs(filters);

  const headers = [
    "ID",
    "Timestamp",
    "User ID",
    "User Email",
    "Action",
    "Resource",
    "Resource ID",
    "Method",
    "Endpoint",
    "Status",
    "IP Address",
    "User Agent",
    "Hash",
  ];

  const rows = entries.map((entry) => [
    entry.id,
    entry.timestamp,
    entry.userId,
    entry.userEmail || "",
    entry.action,
    entry.resource,
    entry.resourceId || "",
    entry.method,
    entry.endpoint,
    entry.status,
    entry.ipAddress,
    entry.userAgent,
    entry.hash,
  ]);

  const csv = [
    headers.join(","),
    ...rows.map((row) =>
      row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(","),
    ),
  ].join("\n");

  return csv;
}

/**
 * Get audit statistics
 */
export async function getAuditStatistics(): Promise<{
  totalEntries: number;
  uniqueUsers: number;
  actionCounts: Record<string, number>;
  resourceCounts: Record<string, number>;
  lastEntry?: AuditLogEntry;
}> {
  const entries = await getAuditLogs({ limit: 10000 });

  const uniqueUsers = new Set(entries.map((e) => e.userId)).size;
  const actionCounts: Record<string, number> = {};
  const resourceCounts: Record<string, number> = {};

  for (const entry of entries) {
    actionCounts[entry.action] = (actionCounts[entry.action] || 0) + 1;
    resourceCounts[entry.resource] = (resourceCounts[entry.resource] || 0) + 1;
  }

  return {
    totalEntries: entries.length,
    uniqueUsers,
    actionCounts,
    resourceCounts,
    lastEntry: entries[0],
  };
}

// ── Admin confirmation / cancellation helpers ─────────────────────────────

/**
 * Record a successful admin confirmation.
 *
 * Call this after the admin action has been applied successfully.
 * It creates a signed, chained audit entry with:
 *   - action = ADMIN_ACTION_CONFIRMED
 *   - the actor, target resource, changes, and the confirmation text
 *
 * This is intentionally a direct call (not middleware-based) so it can be
 * used in service-layer code that does not have an Express req/res in scope.
 */
export async function recordAdminConfirmation(
  input: AdminConfirmationInput,
): Promise<AuditLogEntry> {
  const id = crypto.randomUUID();
  const timestamp = new Date().toISOString();

  const entryData: Omit<AuditLogEntry, "hash" | "signature"> = {
    id,
    timestamp,
    userId: input.actorId || "ANONYMOUS",
    userEmail: input.actorEmail,
    action: "ADMIN_ACTION_CONFIRMED",
    resource: input.resource,
    resourceId: input.resourceId,
    // method / endpoint are synthetic since this is a direct call
    method: "INTERNAL",
    endpoint: `admin/${input.actionType.toLowerCase()}`,
    status: 200,
    changes: input.changes,
    ipAddress: input.ipAddress ?? "INTERNAL",
    userAgent: input.userAgent ?? "INTERNAL",
    previousHash,
    confirmationText: input.confirmationText,
  };

  const hash = generateHash(entryData);
  const signature = generateSignature(hash);
  const entry: AuditLogEntry = { ...entryData, hash, signature };

  auditLog.push(entry);
  previousHash = hash;

  try {
    await fs.appendFile(AUDIT_LOG_FILE, JSON.stringify(entry) + "\n");
  } catch (err) {
    console.error("Failed to persist admin confirmation audit entry:", err);
  }

  return entry;
}

/**
 * Record that an admin cancelled an action without applying changes.
 *
 * This creates an audit entry with:
 *   - action = ADMIN_ACTION_CANCELLED
 *   - cancelled = true
 *   - NO changes field (nothing was applied)
 *
 * Cancelled records are stored so there is a paper trail of intent even
 * when the actor chose not to proceed.
 */
export async function recordCancelledAction(input: {
  actorId: string;
  actorEmail?: string;
  actionType: string;
  resource: string;
  resourceId?: string;
  /** Optional note about why the action was cancelled */
  cancellationReason?: string;
  ipAddress?: string;
  userAgent?: string;
}): Promise<AuditLogEntry> {
  const id = crypto.randomUUID();
  const timestamp = new Date().toISOString();

  const entryData: Omit<AuditLogEntry, "hash" | "signature"> = {
    id,
    timestamp,
    userId: input.actorId || "ANONYMOUS",
    userEmail: input.actorEmail,
    action: "ADMIN_ACTION_CANCELLED",
    resource: input.resource,
    resourceId: input.resourceId,
    method: "INTERNAL",
    endpoint: `admin/${input.actionType.toLowerCase()}`,
    status: 200,
    // No changes — nothing was applied
    ipAddress: input.ipAddress ?? "INTERNAL",
    userAgent: input.userAgent ?? "INTERNAL",
    previousHash,
    cancelled: true,
    ...(input.cancellationReason !== undefined && {
      confirmationText: `CANCELLED: ${input.cancellationReason}`,
    }),
  };

  const hash = generateHash(entryData);
  const signature = generateSignature(hash);
  const entry: AuditLogEntry = { ...entryData, hash, signature };

  auditLog.push(entry);
  previousHash = hash;

  try {
    await fs.appendFile(AUDIT_LOG_FILE, JSON.stringify(entry) + "\n");
  } catch (err) {
    console.error("Failed to persist cancelled action audit entry:", err);
  }

  return entry;
}
