import { IncidentService } from "../services/incidentService";

<<<<<<< feature/yield-opportunities-#248-#256-#255-#250
jest.mock("@prisma/client", () => ({
  PrismaClient: jest.fn().mockImplementation(() => ({
    incident: {
      create: jest.fn().mockResolvedValue({
        id: "incident-123",
        protocol: "TestProtocol",
        severity: "HIGH",
        type: "PAUSE",
        title: "Test Incident",
        description: "A test incident for verification",
        affectedVaults: ["Vault1"],
        startedAt: new Date(),
        resolved: false,
        resolvedAt: null,
      }),
      findMany: jest.fn().mockResolvedValue([{
        id: "incident-123",
        protocol: "TestProtocol",
        severity: "HIGH",
        type: "PAUSE",
        title: "Test Incident",
        description: "A test incident for verification",
        affectedVaults: ["Vault1"],
        startedAt: new Date(),
        resolved: false,
        resolvedAt: null,
      }]),
      update: jest.fn().mockResolvedValue({
        id: "incident-123",
        protocol: "TestProtocol",
        severity: "HIGH",
        type: "PAUSE",
        title: "Test Incident",
        description: "A test incident for verification",
        affectedVaults: ["Vault1"],
        startedAt: new Date(),
        resolved: true,
        resolvedAt: new Date(),
      }),
      delete: jest.fn().mockResolvedValue({
        id: "incident-123",
      }),
    },
  })),
}));

import { incidentService } from "../services/incidentService";

const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();
=======
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
>>>>>>> main

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
});
