import { DriftService } from "../services/driftService";
import { dispatchDriftAlert } from "../services/alertsService";

jest.mock("../config/targetAllocations", () => ({
  TARGET_ALLOCATIONS: [
    { vaultId: "VaultA", targetWeight: 0.60, driftThreshold: 0.05 },
    { vaultId: "VaultB", targetWeight: 0.40, driftThreshold: 0.05 },
  ],
}));

jest.mock("../services/alertsService", () => ({
  dispatchDriftAlert: jest.fn(),
}));

jest.mock("@prisma/client", () => {
  const findFirst = jest.fn();
  const create = jest.fn();
  const update = jest.fn();
  return {
    PrismaClient: jest.fn().mockImplementation(() => ({
      driftEvent: {
        findFirst,
        create,
        update,
      }
    })),
  };
});

const prismaMock = {
  driftEvent: {
    findFirst: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  },
};
const mockDriftEventFindFirst = prismaMock.driftEvent.findFirst;
const mockDriftEventCreate = prismaMock.driftEvent.create;
const mockDriftEventUpdate = prismaMock.driftEvent.update;

describe("DriftService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("should do nothing if total USD is zero", async () => {
    await DriftService.evaluateDriftEvents({ VaultA: 0, VaultB: 0 });
    expect(mockDriftEventFindFirst).not.toHaveBeenCalled();
  });

  it("should not create event if within threshold", async () => {
    mockDriftEventFindFirst.mockResolvedValue(null);

    await DriftService.evaluateDriftEvents({ VaultA: 610, VaultB: 390 });

    expect(mockDriftEventCreate).not.toHaveBeenCalled();
    expect(dispatchDriftAlert).not.toHaveBeenCalled();
  });

  it("should trigger overweight alert and create event", async () => {
    mockDriftEventFindFirst.mockResolvedValue(null);

    await DriftService.evaluateDriftEvents({ VaultA: 700, VaultB: 300 });

    expect(mockDriftEventCreate).toHaveBeenCalledTimes(2); 
    expect(dispatchDriftAlert).toHaveBeenCalledTimes(2);

    expect(dispatchDriftAlert).toHaveBeenCalledWith(
      "VaultA", 0.6, 0.7, expect.any(Number), "overweight"
    );
    expect(dispatchDriftAlert).toHaveBeenCalledWith(
      "VaultB", 0.4, 0.3, expect.any(Number), "underweight"
    );
  });

  it("should ignore if already drifting (deduplication)", async () => {
    mockDriftEventFindFirst.mockResolvedValue({
      id: "drift-1",
      vaultId: "VaultA",
      isRecovered: false,
    });

    await DriftService.evaluateDriftEvents({ VaultA: 700, VaultB: 300 });

    expect(mockDriftEventCreate).not.toHaveBeenCalled();
  });

  it("should resolve and send recovery alert when weight normalizes", async () => {
    // Only return an unrecovered drift event for the first vault finding to simulate A recovering.
    mockDriftEventFindFirst
      .mockResolvedValueOnce({
        id: "drift-1",
        vaultId: "VaultA",
        isRecovered: false,
      })
      .mockResolvedValueOnce(null);

    await DriftService.evaluateDriftEvents({ VaultA: 600, VaultB: 400 });

    expect(mockDriftEventUpdate).toHaveBeenCalledTimes(1);
    expect(mockDriftEventUpdate).toHaveBeenCalledWith({
      where: { id: "drift-1" },
      data: { isRecovered: true, resolvedAt: expect.any(Date) },
    });

    expect(dispatchDriftAlert).toHaveBeenCalledTimes(1);
    expect(dispatchDriftAlert).toHaveBeenCalledWith(
      "VaultA", 0.6, 0.6, 0, "recovered"
    );
  });
});
