import { getUnwindQuote } from "../deltaNeutralUnwindQuote";
import { simulateReadOnlyCall } from "../sorobanReader";

jest.mock("../sorobanReader", () => ({
  ...jest.requireActual("../sorobanReader"),
  simulateReadOnlyCall: jest.fn(),
}));

const mockSimulate = simulateReadOnlyCall as jest.MockedFunction<typeof simulateReadOnlyCall>;

const STRATEGY_ID = "CSTRATEGY0000000000000000000000000000000000000000000000";
const SPOT_TOKEN = "CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526";
const ORACLE = "CORACLE000000000000000000000000000000000000000000000000";
const DEPOSITOR = "GDUCV5RQDUTVA6EXEAHRNR5FSCQT67J2FMNXEBH67UEWB4FWM3S65HIY";

const OPEN_POSITION = {
  owner: DEPOSITOR,
  usdc_deposited: 100_000_0000000,
  spot_amount: 500_0000000, // 500 units, 7-decimal scale
  perp_notional: 100_000_0000000, // 100,000 USDC, 1e7 scale
  entry_price: 2_0000000, // $2.00, 1e7 scale
  funding_collected: 500_0000000, // 500 USDC accrued funding
  is_open: true,
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe("getUnwindQuote", () => {
  it("complete: quotes both legs and allows execution when position + price are available", async () => {
    mockSimulate.mockImplementation(async (_contractId, method) => {
      if (method === "get_position") return { ok: true, value: OPEN_POSITION };
      if (method === "get_price") return { ok: true, value: 2_0000000 }; // unchanged price
      throw new Error(`unexpected method ${method}`);
    });

    const quote = await getUnwindQuote(STRATEGY_ID, SPOT_TOKEN, ORACLE, DEPOSITOR);

    expect(quote.canExecute).toBe(true);
    expect(quote.legs).toHaveLength(2);
    expect(quote.legs.every((l) => l.status === "quoted")).toBe(true);
    expect(quote.totalExpectedUsdc).toBeDefined();
    expect(quote.isEstimate).toBe(true);
  });

  it("partial: names the unavailable leg and reason when the oracle price cannot be read, but perp still quotes a funding-only floor", async () => {
    mockSimulate.mockImplementation(async (_contractId, method) => {
      if (method === "get_position") return { ok: true, value: OPEN_POSITION };
      if (method === "get_price") return { ok: false, reason: "unreachable" };
      throw new Error(`unexpected method ${method}`);
    });

    const quote = await getUnwindQuote(STRATEGY_ID, SPOT_TOKEN, ORACLE, DEPOSITOR);

    const spotLeg = quote.legs.find((l) => l.leg === "spot")!;
    const perpLeg = quote.legs.find((l) => l.leg === "perp")!;

    expect(spotLeg.status).toBe("unavailable");
    expect(spotLeg.reason).toMatch(/oracle/i);
    expect(perpLeg.status).toBe("quoted");
    expect(perpLeg.expectedOutputUsdc).toBe(String(OPEN_POSITION.funding_collected));

    // A required leg (spot) is unavailable — unsafe to proceed.
    expect(quote.canExecute).toBe(false);
  });

  it("unavailable: names both legs unavailable when there is no open position", async () => {
    mockSimulate.mockImplementation(async (_contractId, method) => {
      if (method === "get_position") return { ok: true, value: null };
      throw new Error(`unexpected method ${method}`);
    });

    const quote = await getUnwindQuote(STRATEGY_ID, SPOT_TOKEN, ORACLE, DEPOSITOR);

    expect(quote.canExecute).toBe(false);
    expect(quote.legs).toHaveLength(2);
    for (const leg of quote.legs) {
      expect(leg.status).toBe("unavailable");
      expect(leg.reason).toBeDefined();
    }
  });

  it("unavailable: treats a closed position the same as no position", async () => {
    mockSimulate.mockImplementation(async (_contractId, method) => {
      if (method === "get_position") return { ok: true, value: { ...OPEN_POSITION, is_open: false } };
      throw new Error(`unexpected method ${method}`);
    });

    const quote = await getUnwindQuote(STRATEGY_ID, SPOT_TOKEN, ORACLE, DEPOSITOR);
    expect(quote.canExecute).toBe(false);
    expect(quote.legs.every((l) => l.status === "unavailable")).toBe(true);
  });

  it("never throws even when the position read itself fails", async () => {
    mockSimulate.mockResolvedValue({ ok: false, reason: "unreachable" });

    await expect(getUnwindQuote(STRATEGY_ID, SPOT_TOKEN, ORACLE, DEPOSITOR)).resolves.toBeDefined();
  });
});
