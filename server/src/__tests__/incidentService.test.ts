import { IncidentService } from "../services/incidentService";

// Mock the entire Prisma client to avoid needing a real DB in CI
jest.mock("@prisma/client", () => {
  const mockIncident = {
    id: "mock-id-123",
    protocol: "TestProtocol",
    severity: "HIGH",
    type: "PAUSE",
    title: "Test Incident",
    description: "A test incident for verification",
    affectedVaults: ["Vault1"],
    startedAt: new Date(),
    resolved: false,
    resolvedAt: null,
  };

  const mockPrisma = {
    incident: {
      create: jest.fn().mockResolvedValue(mockIncident),
      update: jest.fn().mockResolvedValue({ ...mockIncident, resolved: true, resolvedAt: new Date() }),
      findMany: jest.fn().mockResolvedValue([mockIncident]),
      findUnique: jest.fn().mockResolvedValue(mockIncident),
      delete: jest.fn().mockResolvedValue(mockIncident),
    },
    $disconnect: jest.fn(),
  };

  return {
    PrismaClient: jest.fn(() => mockPrisma),
    Incident: {},
  };
});

describe("IncidentService", () => {
  const service = new IncidentService();

  it("should create a new incident", async () => {
    const data = {
      protocol: "TestProtocol",
      severity: "HIGH",
      type: "PAUSE",
      title: "Test Incident",
      description: "A test incident for verification",
      affectedVaults: ["Vault1"],
      startedAt: new Date(),
    };

    const incident = await service.createIncident(data);

    expect(incident.protocol).toBe("TestProtocol");
    expect(incident.severity).toBe("HIGH");
    expect(incident.resolved).toBe(false);
  });

  it("normalizes an inconsistent severity label before persisting (#1318)", async () => {
    const { PrismaClient } = require("@prisma/client");
    const prisma = new PrismaClient();

    await service.createIncident({
      protocol: "TestProtocol",
      severity: "critical", // lowercase alias -> should normalize to "CRITICAL"
      type: "PAUSE",
      title: "Lowercase severity incident",
      description: "Severity provided in an inconsistent casing",
      affectedVaults: ["Vault1"],
      startedAt: new Date(),
    });

    expect(prisma.incident.create).toHaveBeenLastCalledWith({
      data: expect.objectContaining({ severity: "CRITICAL" }),
    });
  });

  it("normalizes an unknown severity label to the default (#1318)", async () => {
    const { PrismaClient } = require("@prisma/client");
    const prisma = new PrismaClient();

    await service.createIncident({
      protocol: "TestProtocol",
      severity: "sev1", // unrecognized -> falls back to default (MEDIUM)
      type: "PAUSE",
      title: "Unknown severity incident",
      description: "Severity provided as an unrecognized label",
      affectedVaults: ["Vault1"],
      startedAt: new Date(),
    });

    expect(prisma.incident.create).toHaveBeenLastCalledWith({
      data: expect.objectContaining({ severity: "MEDIUM" }),
    });
  });

  it("should fetch incidents with filters", async () => {
    const incidents = await service.getIncidents({ protocol: "TestProtocol" });
    expect(incidents.length).toBeGreaterThan(0);
    expect(incidents[0].protocol).toBe("TestProtocol");
  });

  it("should resolve an incident", async () => {
    const resolved = await service.resolveIncident("mock-id-123");
    expect(resolved.resolved).toBe(true);
    expect(resolved.resolvedAt).not.toBeNull();
  });

  it("should get incident by id", async () => {
    const incident = await service.getIncidentById("mock-id-123");
    expect(incident).not.toBeNull();
    expect(incident?.id).toBe("mock-id-123");
  });

  it("merges duplicate timeline notifications from different sources (#1110)", () => {
    const startedAt = new Date("2026-05-01T00:00:00Z");
    const merged = service.mergeTimelineNotifications([
      {
        id: "n1",
        source: "on-chain-monitor",
        protocol: "Blend",
        type: "PAUSE",
        severity: "MEDIUM",
        title: "Blend vault paused",
        description: "Paused",
        affectedVaults: ["Vault1"],
        startedAt,
        resolved: false,
      },
      {
        id: "n2",
        source: "ops-manual",
        protocol: "Blend",
        type: "PAUSE",
        severity: "CRITICAL",
        title: "Blend USDC vault paused by guardian after oracle anomaly",
        description: "Guardian multisig paused the vault after an oracle anomaly.",
        affectedVaults: ["Vault1", "Vault2"],
        startedAt: new Date(startedAt.getTime() + 30_000),
        resolved: false,
      },
    ]);

    expect(merged).toHaveLength(1);
    expect(merged[0].sources).toEqual(["ops-manual", "on-chain-monitor"].sort());
    expect(merged[0].severity).toBe("CRITICAL");
    expect(merged[0].affectedVaults).toEqual(["Vault1", "Vault2"]);
  });

  it("keeps unrelated incidents from different sources as separate merged entries", () => {
    const merged = service.mergeTimelineNotifications([
      {
        id: "n1",
        source: "on-chain-monitor",
        protocol: "Blend",
        type: "PAUSE",
        severity: "MEDIUM",
        title: "Blend vault paused",
        description: "Paused",
        affectedVaults: ["Vault1"],
        startedAt: new Date("2026-05-01T00:00:00Z"),
        resolved: false,
      },
      {
        id: "n2",
        source: "ops-manual",
        protocol: "Soroswap",
        type: "DEPEG",
        severity: "HIGH",
        title: "Soroswap pool depeg",
        description: "Depeg detected",
        affectedVaults: ["VaultX"],
        startedAt: new Date("2026-05-01T00:00:00Z"),
        resolved: false,
      },
    ]);

    expect(merged).toHaveLength(2);
  });

  it("should build postmortem linking guidance for transparency views", () => {
    const guidance = service.getPostmortemLinkingGuidance({
      id: "incident-42",
      title: "Provider RPC outage: Blend USDC vault",
      startedAt: new Date("2026-05-27T08:15:00.000Z"),
      resolved: true,
    });

    expect(guidance).toEqual({
      incidentId: "incident-42",
      title: "Provider RPC outage: Blend USDC vault",
      status: "resolved",
      templatePath: "docs/postmortems/TEMPLATE.md",
      expectedPostmortemPath: "docs/postmortems/2026-05-27-provider-rpc-outage-blend-usdc-vault.md",
      linkField: "postmortemUrl",
      displayLabel: "Postmortem: Provider RPC outage: Blend USDC vault",
      transparencyHint:
        "Render postmortemUrl in incident records and transparency views after mitigation or resolution.",
    });
  });
});
