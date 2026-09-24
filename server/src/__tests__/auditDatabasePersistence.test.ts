/**
 * Tests for the Prisma-backed durability layer added to the audit trail
 * (#1329). The hash-chain/signature scheme itself is exercised by the
 * existing audit test suites (auditReplay, adminAuditRecords, etc); these
 * tests cover only the new write-through-to-database and
 * verifyPersistedAuditTrailIntegrity behavior.
 */

const mockCreate = jest.fn();
const mockFindMany = jest.fn();

jest.mock("@prisma/client", () => ({
  PrismaClient: jest.fn().mockImplementation(() => ({
    criticalActionAuditLog: {
      create: mockCreate,
      findMany: mockFindMany,
    },
  })),
}));

import {
  resetAuditLog,
  createAuditEntry,
  verifyPersistedAuditTrailIntegrity,
} from "../middleware/audit";

function fakeReqRes(statusCode = 200) {
  return [
    { method: "POST", path: "/api/admin/test", headers: {}, ip: "127.0.0.1" } as any,
    { statusCode } as any,
  ] as const;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockCreate.mockResolvedValue({});
  resetAuditLog();
  // Force a fresh dynamic import of @prisma/client on the next audit write,
  // since loadAuditPrismaClient caches the client module-level.
  jest.resetModules();
});

describe("createAuditEntry database persistence", () => {
  it("writes the entry to the database with matching id/hash/previousHash", async () => {
    const [req, res] = fakeReqRes();
    const entry = await createAuditEntry(req, res, {
      action: "UPDATE_VAULT_REGISTRY",
      resource: "VAULT_REGISTRY",
      resourceId: "usdc",
      changes: { status: "PAUSED" },
    });

    expect(mockCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        id: entry.id,
        hash: entry.hash,
        previousHash: entry.previousHash,
        action: "UPDATE_VAULT_REGISTRY",
        resourceId: "usdc",
      }),
    });
  });

  it("does not throw and still returns the entry when the database write fails", async () => {
    mockCreate.mockRejectedValue(new Error("connection refused"));
    const [req, res] = fakeReqRes();

    const entry = await createAuditEntry(req, res, {
      action: "PAUSE_VAULT",
      resource: "VAULT",
      resourceId: "xlm",
    });

    expect(entry.action).toBe("PAUSE_VAULT");
    expect(entry.hash).toBeDefined();
  });
});

describe("verifyPersistedAuditTrailIntegrity", () => {
  it("returns isValid: true for a correctly chained set of persisted rows", async () => {
    const [req, res] = fakeReqRes();
    const first = await createAuditEntry(req, res, { action: "A", resource: "R" });
    const second = await createAuditEntry(req, res, { action: "B", resource: "R" });

    mockFindMany.mockResolvedValue([
      { ...first, timestamp: new Date(first.timestamp) },
      { ...second, timestamp: new Date(second.timestamp) },
    ]);

    const result = await verifyPersistedAuditTrailIntegrity();
    expect(result?.isValid).toBe(true);
    expect(result?.invalidEntries).toEqual([]);
  });

  it("detects a broken chain when a persisted row's hash was tampered with", async () => {
    const [req, res] = fakeReqRes();
    const first = await createAuditEntry(req, res, { action: "A", resource: "R" });
    const second = await createAuditEntry(req, res, { action: "B", resource: "R" });

    mockFindMany.mockResolvedValue([
      { ...first, timestamp: new Date(first.timestamp), hash: "tampered-hash" },
      { ...second, timestamp: new Date(second.timestamp) },
    ]);

    const result = await verifyPersistedAuditTrailIntegrity();
    expect(result?.isValid).toBe(false);
    expect(result?.invalidEntries.length).toBeGreaterThan(0);
  });

  it("orders rows by timestamp ascending when querying", async () => {
    mockFindMany.mockResolvedValue([]);
    await verifyPersistedAuditTrailIntegrity();

    expect(mockFindMany).toHaveBeenCalledWith({
      orderBy: { timestamp: "asc" },
    });
  });
});
