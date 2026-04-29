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
}

export interface AuditContext {
  userId?: string;
  userEmail?: string;
  action?: string;
  resource?: string;
  resourceId?: string;
  changes?: Record<string, unknown>;
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
    | { id?: string; email?: string }
    | undefined;
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
  return req.socket.remoteAddress || "UNKNOWN";
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
  const id = crypto.randomUUID();
  const timestamp = new Date().toISOString();

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
 * Retrieve audit logs with optional filtering
 */
export async function getAuditLogs(filters?: {
  userId?: string;
  action?: string;
  resource?: string;
  startDate?: string;
  endDate?: string;
  limit?: number;
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

  // Sort by timestamp descending
  results.sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
  );

  // Apply limit
  const limit = filters?.limit || 100;
  return results.slice(0, limit);
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
