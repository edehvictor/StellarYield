import request from "supertest";
import { createApp } from "../app";
import { getUnwindQuote } from "../services/deltaNeutralUnwindQuote";

jest.mock("../services/deltaNeutralUnwindQuote", () => ({
  getUnwindQuote: jest.fn(),
}));

const mockGetUnwindQuote = getUnwindQuote as jest.MockedFunction<typeof getUnwindQuote>;

const STRATEGY_ID = "CSTRATEGY0000000000000000000000000000000000000000000000";
const SPOT_TOKEN = "CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526";
const ORACLE = "CABAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAFNSZ";
const DEPOSITOR = "GDUCV5RQDUTVA6EXEAHRNR5FSCQT67J2FMNXEBH67UEWB4FWM3S65HIY";

describe("GET /api/strategies/delta-neutral/:contractId/unwind-quote (#1171)", () => {
  const app = createApp();

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns 400 when depositor is missing", async () => {
    const res = await request(app)
      .get(`/api/strategies/delta-neutral/${STRATEGY_ID}/unwind-quote`)
      .query({ spotToken: SPOT_TOKEN, oracle: ORACLE });

    expect(res.status).toBe(400);
    expect(mockGetUnwindQuote).not.toHaveBeenCalled();
  });

  it("returns 400 when depositor is not a valid account address", async () => {
    const res = await request(app)
      .get(`/api/strategies/delta-neutral/${STRATEGY_ID}/unwind-quote`)
      .query({ depositor: "not-an-address", spotToken: SPOT_TOKEN, oracle: ORACLE });

    expect(res.status).toBe(400);
  });

  it("returns 400 when spotToken is not a valid contract address", async () => {
    const res = await request(app)
      .get(`/api/strategies/delta-neutral/${STRATEGY_ID}/unwind-quote`)
      .query({ depositor: DEPOSITOR, spotToken: "not-a-contract", oracle: ORACLE });

    expect(res.status).toBe(400);
  });

  it("returns the quote payload on a valid request, including an unsafe (canExecute:false) preview", async () => {
    mockGetUnwindQuote.mockResolvedValue({
      depositor: DEPOSITOR,
      legs: [
        { leg: "spot", status: "unavailable", reason: "Price oracle unreachable." },
        { leg: "perp", status: "quoted", expectedOutputUsdc: "500" },
      ],
      canExecute: false,
      riskNotes: ["Price oracle unreachable."],
      isEstimate: true,
      quotedAt: new Date().toISOString(),
    });

    const res = await request(app)
      .get(`/api/strategies/delta-neutral/${STRATEGY_ID}/unwind-quote`)
      .query({ depositor: DEPOSITOR, spotToken: SPOT_TOKEN, oracle: ORACLE });

    expect(res.status).toBe(200);
    expect(res.body.canExecute).toBe(false);
    expect(res.body.legs.find((l: { leg: string }) => l.leg === "spot").status).toBe("unavailable");
    expect(mockGetUnwindQuote).toHaveBeenCalledWith(STRATEGY_ID, SPOT_TOKEN, ORACLE, DEPOSITOR);
  });
});
