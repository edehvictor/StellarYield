import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import RebalanceBacktestPanel from "./RebalanceBacktestPanel";

const result = (overrides: Record<string, unknown> = {}) => ({
  isSimulationOnly: true,
  startDate: "2025-01-01",
  endDate: "2025-01-10",
  initialValueUsd: 100_000,
  finalPortfolioValue: 91_000,
  finalPassiveValue: 90_500,
  portfolioReturnPct: -9,
  passiveReturnPct: -9.5,
  outperformancePct: 0.5,
  rebalanceCount: 0,
  totalFeesUsd: 0,
  negativeYieldDays: 10,
  maxDrawdownPct: 9.25,
  passiveMaxDrawdownPct: 9.5,
  snapshots: [
    { date: "2025-01-01", portfolioValue: 99_000, passiveValue: 99_000, rebalanced: false, blendedApyPct: -3 },
    { date: "2025-01-02", portfolioValue: 98_000, passiveValue: 98_000, rebalanced: false, blendedApyPct: -3 },
  ],
  rebalanceEvents: [],
  warnings: [],
  ...overrides,
});

let fetchSpy: ReturnType<typeof vi.spyOn>;

function respond(body: unknown, status = 200) {
  fetchSpy.mockImplementation(() =>
    Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })),
  );
}

function sentBody() {
  const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
  return JSON.parse(String(init.body)) as {
    allocations: Array<{ label: string; targetWeight: number; apy: number }>;
  };
}

function fillDates() {
  const [start, end] = Array.from(document.querySelectorAll('input[type="date"]')) as HTMLInputElement[];
  fireEvent.change(start, { target: { value: "2025-01-01" } });
  fireEvent.change(end, { target: { value: "2025-01-10" } });
}

async function setApy(label: string, text: string) {
  const field = screen.getByLabelText(`APY for ${label} (%)`);
  await userEvent.clear(field);
  if (text) await userEvent.type(field, text);
  return field;
}

const run = () => userEvent.click(screen.getByRole("button", { name: /Run Backtest/ }));

beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, "fetch");
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("RebalanceBacktestPanel — negative yield", () => {
  it("lets a negative APY be typed character by character", async () => {
    render(<RebalanceBacktestPanel />);

    const field = await setApy("Pool A", "-2.5");

    expect(field).toHaveValue("-2.5");
    expect(field).not.toHaveAttribute("aria-invalid");
  });

  it("sends a negative APY to the API", async () => {
    respond(result());
    render(<RebalanceBacktestPanel />);
    fillDates();
    await setApy("Pool A", "-5");

    await run();

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    expect(sentBody().allocations).toEqual([
      { label: "Pool A", targetWeight: 50, apy: -5 },
      { label: "Pool B", targetWeight: 50, apy: 12 },
    ]);
  });

  it("still sends positive and blank APYs as before", async () => {
    respond(result());
    render(<RebalanceBacktestPanel />);
    fillDates();
    await setApy("Pool B", "");

    await run();

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    expect(sentBody().allocations.map((a) => a.apy)).toEqual([8, 0]);
  });

  it("flags an APY below the floor and does not send the request", async () => {
    render(<RebalanceBacktestPanel />);
    fillDates();
    const field = await setApy("Pool A", "-250");

    expect(field).toHaveAttribute("aria-invalid", "true");
    await run();

    expect(await screen.findByText(/Pool A: APY cannot be below -100%/)).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects text that is not a number", async () => {
    render(<RebalanceBacktestPanel />);
    fillDates();
    await setApy("Pool B", "abc");

    await run();

    expect(await screen.findByText(/Pool B: Enter a number/)).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("shows the drawdown and negative-yield summary from the result", async () => {
    respond(result());
    render(<RebalanceBacktestPanel />);
    fillDates();

    await run();

    const summary = await screen.findByTestId("loss-summary");
    expect(summary).toHaveTextContent("Max drawdown 9.25% (passive 9.50%)");
    expect(summary).toHaveTextContent("Negative-yield days 10 of 2");
    expect(screen.getByText("-9.00%")).toBeInTheDocument();
  });

  it("renders the negative-yield and capital-loss warnings", async () => {
    respond(
      result({
        warnings: [
          {
            code: "NEGATIVE_YIELD_PERIOD",
            severity: "warning",
            affectedField: "allocations[Pool A].apy",
            message: '"Pool A" earns a negative yield on 10 of 10 simulated days.',
            remediation: "Confirm the negative yield is intended.",
          },
          {
            code: "CAPITAL_LOSS",
            severity: "warning",
            affectedField: "allocations",
            message: "The rebalanced portfolio ends 9% below its starting value of $100000.",
            remediation: "Review the yield assumptions.",
          },
        ],
      }),
    );
    render(<RebalanceBacktestPanel />);
    fillDates();

    await run();

    expect(await screen.findByText(/Backtest Warnings \(2\)/)).toBeInTheDocument();
    const alerts = screen.getAllByRole("alert");
    expect(within(alerts[0]).getByText(/negative yield on 10 of 10/)).toBeInTheDocument();
    expect(within(alerts[1]).getByText(/9% below its starting value/)).toBeInTheDocument();
  });

  it("omits the loss summary for a response from an older server", async () => {
    const legacy = result();
    delete (legacy as Record<string, unknown>).maxDrawdownPct;
    delete (legacy as Record<string, unknown>).passiveMaxDrawdownPct;
    delete (legacy as Record<string, unknown>).negativeYieldDays;
    respond(legacy);
    render(<RebalanceBacktestPanel />);
    fillDates();

    await run();

    await screen.findByText(/Portfolio return/);
    expect(screen.queryByTestId("loss-summary")).not.toBeInTheDocument();
  });

  it("shows why the server rejected the request, not just a generic headline", async () => {
    respond(
      { error: "Invalid backtest parameters", details: ['apy for "Pool A" must be at least -100% (got -101).'] },
      400,
    );
    render(<RebalanceBacktestPanel />);
    fillDates();

    await run();

    expect(await screen.findByText(/Invalid backtest parameters: apy for "Pool A" must be at least -100%/)).toBeInTheDocument();
  });

  it("falls back to the headline when a 400 has no details", async () => {
    respond({ error: "Invalid backtest parameters" }, 400);
    render(<RebalanceBacktestPanel />);
    fillDates();

    await run();

    expect(await screen.findByText("Invalid backtest parameters")).toBeInTheDocument();
  });
});
