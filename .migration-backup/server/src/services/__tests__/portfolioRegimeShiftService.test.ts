import {
  detectAndNotifyRegimeShift,
  getShiftHistory,
  REGIME_SHIFT_COOLDOWN_MS,
} from "../portfolioRegimeShiftService";
import { YieldSnapshot } from "../yieldRegimeService";

// ── Prisma mock (mock-prefixed vars are exempt from jest.mock hoisting rules) ──

const mockAlertFindFirst = jest.fn();
const mockAlertFindMany = jest.fn();
const mockAlertCreate = jest.fn();
const mockAlertUpdate = jest.fn();
const mockNotifCreate = jest.fn();

jest.mock("@prisma/client", () => ({
  PrismaClient: jest.fn().mockImplementation(() => ({
    portfolioRegimeShiftAlert: {
      findFirst: (...a: unknown[]) => mockAlertFindFirst(...a),
      findMany: (...a: unknown[]) => mockAlertFindMany(...a),
      create: (...a: unknown[]) => mockAlertCreate(...a),
      update: (...a: unknown[]) => mockAlertUpdate(...a),
    },
    notification: {
      create: (...a: unknown[]) => mockNotifCreate(...a),
    },
  })),
}));

jest.mock("../emailService");
import { sendEmail } from "../emailService";
const mockSendEmail = sendEmail as jest.MockedFunction<typeof sendEmail>;

// ── Fixtures ──────────────────────────────────────────────────────────────────

const WALLET = "0xabc123";
const now = new Date();

const stableSnapshots: YieldSnapshot[] = Array.from({ length: 5 }, (_, i) => ({
  timestamp: new Date(now.getTime() - i * 3_600_000),
  apyBps: 1000,
  tvlUsd: 500_000,
  volatilityPct: 2,
}));

const highVolSnapshots: YieldSnapshot[] = Array.from({ length: 5 }, (_, i) => ({
  timestamp: new Date(now.getTime() - i * 3_600_000),
  apyBps: 1000,
  tvlUsd: 500_000,
  volatilityPct: 40,
}));

const decliningSnapshots: YieldSnapshot[] = [
  { timestamp: new Date(now.getTime() - 6 * 86_400_000), apyBps: 2000, tvlUsd: 500_000, volatilityPct: 3 },
  { timestamp: new Date(now.getTime() - 3 * 86_400_000), apyBps: 1500, tvlUsd: 490_000, volatilityPct: 3 },
  { timestamp: new Date(now.getTime() - 1 * 86_400_000), apyBps: 1000, tvlUsd: 480_000, volatilityPct: 3 },
];

beforeEach(() => {
  jest.clearAllMocks();
  mockAlertCreate.mockResolvedValue({ id: "alert-001" });
  mockAlertUpdate.mockResolvedValue({});
  mockNotifCreate.mockResolvedValue({});
});

// ── Tests: initial state seeding ──────────────────────────────────────────────

describe("initial state seeding", () => {
  it("seeds initial regime and returns shifted=false on first call", async () => {
    mockAlertFindFirst.mockResolvedValueOnce(null);

    const result = await detectAndNotifyRegimeShift({
      walletAddress: WALLET,
      snapshots: stableSnapshots,
    });

    expect(result.shifted).toBe(false);
    expect(result.previousRegime).toBeNull();
    expect(result.notificationSent).toBe(false);
    expect(mockAlertCreate).toHaveBeenCalledTimes(1);
    expect(mockAlertCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          walletAddress: WALLET.toLowerCase(),
          rationale: "Initial portfolio regime recorded",
        }),
      })
    );
  });

  it("does not send email on initial seed", async () => {
    mockAlertFindFirst.mockResolvedValueOnce(null);

    await detectAndNotifyRegimeShift({
      walletAddress: WALLET,
      snapshots: stableSnapshots,
      email: "user@example.com",
    });

    expect(mockSendEmail).not.toHaveBeenCalled();
  });
});

// ── Tests: no shift ───────────────────────────────────────────────────────────

describe("no regime shift", () => {
  it("returns shifted=false when regime is unchanged", async () => {
    mockAlertFindFirst.mockResolvedValueOnce({ currentRegime: "stable", createdAt: new Date() });

    const result = await detectAndNotifyRegimeShift({
      walletAddress: WALLET,
      snapshots: stableSnapshots,
    });

    expect(result.shifted).toBe(false);
    expect(result.notificationSent).toBe(false);
  });

  it("does not create an alert record when regime is unchanged", async () => {
    mockAlertFindFirst.mockResolvedValueOnce({ currentRegime: "stable", createdAt: new Date() });

    await detectAndNotifyRegimeShift({ walletAddress: WALLET, snapshots: stableSnapshots });

    expect(mockAlertCreate).not.toHaveBeenCalled();
  });
});

// ── Tests: shift detection ────────────────────────────────────────────────────

describe("regime shift detection", () => {
  it("detects stable → high-volatility shift", async () => {
    mockAlertFindFirst
      .mockResolvedValueOnce({ currentRegime: "stable", createdAt: new Date() })
      .mockResolvedValueOnce(null);

    const result = await detectAndNotifyRegimeShift({
      walletAddress: WALLET,
      snapshots: highVolSnapshots,
    });

    expect(result.shifted).toBe(true);
    expect(result.previousRegime).toBe("stable");
    expect(result.currentRegime).toBe("high-volatility");
    expect(result.alertId).toBe("alert-001");
  });

  it("detects stable → declining-yield shift", async () => {
    mockAlertFindFirst
      .mockResolvedValueOnce({ currentRegime: "stable", createdAt: new Date() })
      .mockResolvedValueOnce(null);

    const result = await detectAndNotifyRegimeShift({
      walletAddress: WALLET,
      snapshots: decliningSnapshots,
    });

    expect(result.shifted).toBe(true);
    expect(result.previousRegime).toBe("stable");
    expect(result.currentRegime).toBe("declining-yield");
  });

  it("creates an alert record on shift", async () => {
    mockAlertFindFirst
      .mockResolvedValueOnce({ currentRegime: "stable", createdAt: new Date() })
      .mockResolvedValueOnce(null);

    await detectAndNotifyRegimeShift({
      walletAddress: WALLET,
      snapshots: highVolSnapshots,
    });

    expect(mockAlertCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          walletAddress: WALLET.toLowerCase(),
          previousRegime: "stable",
          currentRegime: "high-volatility",
        }),
      })
    );
  });

  it("creates an in-app notification on shift", async () => {
    mockAlertFindFirst
      .mockResolvedValueOnce({ currentRegime: "stable", createdAt: new Date() })
      .mockResolvedValueOnce(null);

    await detectAndNotifyRegimeShift({
      walletAddress: WALLET,
      snapshots: highVolSnapshots,
    });

    expect(mockNotifCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          walletAddress: WALLET.toLowerCase(),
          type: "REGIME_SHIFT",
        }),
      })
    );
  });

  it("normalises walletAddress to lowercase", async () => {
    mockAlertFindFirst
      .mockResolvedValueOnce({ currentRegime: "stable", createdAt: new Date() })
      .mockResolvedValueOnce(null);

    await detectAndNotifyRegimeShift({
      walletAddress: "0xABC123",
      snapshots: highVolSnapshots,
    });

    expect(mockAlertCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ walletAddress: "0xabc123" }),
      })
    );
  });
});

// ── Tests: low confidence suppression ────────────────────────────────────────

describe("low confidence suppression", () => {
  it("does not send notification when confidence is below threshold", async () => {
    // Zero snapshots → confidence = 0
    mockAlertFindFirst.mockResolvedValueOnce({ currentRegime: "stable", createdAt: new Date() });

    const result = await detectAndNotifyRegimeShift({
      walletAddress: WALLET,
      snapshots: [],
      email: "user@example.com",
    });

    expect(result.notificationSent).toBe(false);
    expect(mockSendEmail).not.toHaveBeenCalled();
  });
});

// ── Tests: cooldown / deduplication ──────────────────────────────────────────

describe("cooldown deduplication", () => {
  it("blocks notification when same transition is within cooldown window", async () => {
    mockAlertFindFirst
      .mockResolvedValueOnce({ currentRegime: "stable", createdAt: new Date() })
      .mockResolvedValueOnce({
        id: "old-alert",
        walletAddress: WALLET,
        previousRegime: "stable",
        currentRegime: "high-volatility",
        createdAt: new Date(Date.now() - 1_000),
      });

    const result = await detectAndNotifyRegimeShift({
      walletAddress: WALLET,
      snapshots: highVolSnapshots,
      email: "user@example.com",
    });

    expect(result.shifted).toBe(true);
    expect(result.cooldownActive).toBe(true);
    expect(result.notificationSent).toBe(false);
    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(mockAlertCreate).not.toHaveBeenCalled();
  });

  it("allows notification when cooldown has expired", async () => {
    mockAlertFindFirst
      .mockResolvedValueOnce({ currentRegime: "stable", createdAt: new Date() })
      .mockResolvedValueOnce(null);

    mockSendEmail.mockResolvedValueOnce(undefined);

    const result = await detectAndNotifyRegimeShift({
      walletAddress: WALLET,
      snapshots: highVolSnapshots,
      email: "user@example.com",
    });

    expect(result.cooldownActive).toBe(false);
    expect(result.shifted).toBe(true);
    expect(mockAlertCreate).toHaveBeenCalled();
    expect(mockSendEmail).toHaveBeenCalled();
  });

  it("cooldown query is scoped to the specific wallet address", async () => {
    mockAlertFindFirst
      .mockResolvedValueOnce({ currentRegime: "stable", createdAt: new Date() })
      .mockResolvedValueOnce(null);

    await detectAndNotifyRegimeShift({
      walletAddress: WALLET,
      snapshots: highVolSnapshots,
    });

    const cooldownCall = mockAlertFindFirst.mock.calls[1][0];
    expect(cooldownCall.where.walletAddress).toBe(WALLET.toLowerCase());
  });

  it("cooldown query matches exact previousRegime and currentRegime", async () => {
    mockAlertFindFirst
      .mockResolvedValueOnce({ currentRegime: "stable", createdAt: new Date() })
      .mockResolvedValueOnce(null);

    await detectAndNotifyRegimeShift({
      walletAddress: WALLET,
      snapshots: highVolSnapshots,
    });

    const cooldownCall = mockAlertFindFirst.mock.calls[1][0];
    expect(cooldownCall.where.previousRegime).toBe("stable");
    expect(cooldownCall.where.currentRegime).toBe("high-volatility");
  });

  it("REGIME_SHIFT_COOLDOWN_MS is 24 hours", () => {
    expect(REGIME_SHIFT_COOLDOWN_MS).toBe(24 * 60 * 60 * 1000);
  });
});

// ── Tests: email notification ─────────────────────────────────────────────────

describe("email notification", () => {
  it("sends email when address is provided", async () => {
    mockAlertFindFirst
      .mockResolvedValueOnce({ currentRegime: "stable", createdAt: new Date() })
      .mockResolvedValueOnce(null);
    mockSendEmail.mockResolvedValueOnce(undefined);

    await detectAndNotifyRegimeShift({
      walletAddress: WALLET,
      snapshots: highVolSnapshots,
      email: "user@example.com",
    });

    expect(mockSendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: "user@example.com" })
    );
  });

  it("does not send email when no address is provided", async () => {
    mockAlertFindFirst
      .mockResolvedValueOnce({ currentRegime: "stable", createdAt: new Date() })
      .mockResolvedValueOnce(null);

    await detectAndNotifyRegimeShift({
      walletAddress: WALLET,
      snapshots: highVolSnapshots,
    });

    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it("marks alert as notified=true after successful email", async () => {
    mockAlertFindFirst
      .mockResolvedValueOnce({ currentRegime: "stable", createdAt: new Date() })
      .mockResolvedValueOnce(null);
    mockSendEmail.mockResolvedValueOnce(undefined);

    await detectAndNotifyRegimeShift({
      walletAddress: WALLET,
      snapshots: highVolSnapshots,
      email: "user@example.com",
    });

    expect(mockAlertUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ notified: true }),
      })
    );
  });

  it("returns notificationSent=false when email dispatch throws", async () => {
    mockAlertFindFirst
      .mockResolvedValueOnce({ currentRegime: "stable", createdAt: new Date() })
      .mockResolvedValueOnce(null);
    mockSendEmail.mockRejectedValueOnce(new Error("SMTP failure"));

    const result = await detectAndNotifyRegimeShift({
      walletAddress: WALLET,
      snapshots: highVolSnapshots,
      email: "user@example.com",
    });

    expect(result.notificationSent).toBe(false);
  });

  it("includes previous and current regime labels in email HTML", async () => {
    mockAlertFindFirst
      .mockResolvedValueOnce({ currentRegime: "stable", createdAt: new Date() })
      .mockResolvedValueOnce(null);
    mockSendEmail.mockResolvedValueOnce(undefined);

    await detectAndNotifyRegimeShift({
      walletAddress: WALLET,
      snapshots: highVolSnapshots,
      email: "user@example.com",
    });

    const { html, subject } = mockSendEmail.mock.calls[0][0];
    expect(html).toContain("High Volatility");
    expect(html).toContain("Stable");
    expect(subject).toContain("High Volatility");
  });
});

// ── Tests: getShiftHistory ────────────────────────────────────────────────────

describe("getShiftHistory", () => {
  it("returns history scoped to the given wallet", async () => {
    const fakeHistory = [
      { id: "a1", walletAddress: WALLET.toLowerCase(), currentRegime: "high-volatility", createdAt: new Date() },
      { id: "a2", walletAddress: WALLET.toLowerCase(), currentRegime: "stable", createdAt: new Date() },
    ];
    mockAlertFindMany.mockResolvedValueOnce(fakeHistory);

    const history = await getShiftHistory(WALLET);

    expect(history).toEqual(fakeHistory);
    expect(mockAlertFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { walletAddress: WALLET.toLowerCase() },
      })
    );
  });

  it("normalises wallet to lowercase in history query", async () => {
    mockAlertFindMany.mockResolvedValueOnce([]);

    await getShiftHistory("0xABC");

    expect(mockAlertFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { walletAddress: "0xabc" },
      })
    );
  });

  it("respects the custom limit parameter", async () => {
    mockAlertFindMany.mockResolvedValueOnce([]);

    await getShiftHistory(WALLET, 5);

    expect(mockAlertFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 5 })
    );
  });

  it("defaults to limit 20 when not specified", async () => {
    mockAlertFindMany.mockResolvedValueOnce([]);

    await getShiftHistory(WALLET);

    expect(mockAlertFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 20 })
    );
  });
});
