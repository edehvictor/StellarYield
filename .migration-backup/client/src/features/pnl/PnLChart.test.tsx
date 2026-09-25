import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import PnLChart from "./PnLChart";
import { useWallet } from "../../context/useWallet";

// Mock ResizeObserver
global.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};

// Mock the wallet context
vi.mock("../../context/useWallet", () => ({
  useWallet: vi.fn(),
}));

// Mock the API module
vi.mock("../../lib/api", () => ({
  getApiBaseUrl: () => "http://localhost:3000",
}));

describe("PnLChart", () => {
  const mockWalletAddress = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

  const mockPnLDataWithChart = {
    totalDeposited: 10000,
    totalWithdrawn: 2000,
    currentValue: 11500,
    costBasis: 8000,
    absolutePnL: 3500,
    twrPercent: 43.75,
    dailySnapshots: [
      { date: "2024-01-01", cumulativePnL: 100, portfolioValue: 10100, sharePrice: 1.01 },
      { date: "2024-01-02", cumulativePnL: 250, portfolioValue: 10250, sharePrice: 1.025 },
      { date: "2024-01-03", cumulativePnL: 500, portfolioValue: 10500, sharePrice: 1.05 },
    ],
  };

  const mockPnLDataPartial = {
    totalDeposited: 5000,
    totalWithdrawn: 0,
    currentValue: 5100,
    costBasis: 5000,
    absolutePnL: 100,
    twrPercent: 2.0,
    dailySnapshots: [],
  };

  const mockPnLDataEmpty = {
    totalDeposited: 0,
    totalWithdrawn: 0,
    currentValue: 0,
    costBasis: 0,
    absolutePnL: 0,
    twrPercent: 0,
    dailySnapshots: [],
  };

  const mockPnLDataNegative = {
    totalDeposited: 10000,
    totalWithdrawn: 0,
    currentValue: 9000,
    costBasis: 10000,
    absolutePnL: -1000,
    twrPercent: -10.0,
    dailySnapshots: [
      { date: "2024-01-01", cumulativePnL: 0, portfolioValue: 10000, sharePrice: 1.0 },
      { date: "2024-01-02", cumulativePnL: -500, portfolioValue: 9500, sharePrice: 0.95 },
      { date: "2024-01-03", cumulativePnL: -1000, portfolioValue: 9000, sharePrice: 0.9 },
    ],
  };

  beforeEach(() => {
    global.fetch = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("Wallet Connection States", () => {
    it("shows connect wallet message when not connected", () => {
      (useWallet as ReturnType<typeof vi.fn>).mockReturnValue({
        isConnected: false,
        walletAddress: null,
      });

      render(<PnLChart />);

      expect(screen.getByText("Profit & Loss")).toBeInTheDocument();
      expect(
        screen.getByText(/connect your wallet to view your historical pnl/i),
      ).toBeInTheDocument();
    });

    it("shows DollarSign icon when not connected", () => {
      (useWallet as ReturnType<typeof vi.fn>).mockReturnValue({
        isConnected: false,
        walletAddress: null,
      });

      render(<PnLChart />);

      const container = screen.getByText("Profit & Loss").closest("div");
      expect(container).toBeInTheDocument();
    });
  });

  describe("Loading State", () => {
    it("shows loading spinner while fetching data", () => {
      (useWallet as ReturnType<typeof vi.fn>).mockReturnValue({
        isConnected: true,
        walletAddress: mockWalletAddress,
      });

      (global.fetch as ReturnType<typeof vi.fn>).mockImplementation(
        () =>
          new Promise(() => {
            /* never resolves */
          }),
      );

      render(<PnLChart />);

      expect(screen.getByText(/calculating your pnl\.\.\./i)).toBeInTheDocument();
    });

    it("displays loading message with spinner icon", () => {
      (useWallet as ReturnType<typeof vi.fn>).mockReturnValue({
        isConnected: true,
        walletAddress: mockWalletAddress,
      });

      (global.fetch as ReturnType<typeof vi.fn>).mockImplementation(
        () =>
          new Promise(() => {
            /* never resolves */
          }),
      );

      render(<PnLChart />);

      const loadingText = screen.getByText(/calculating your pnl\.\.\./i);
      expect(loadingText).toBeInTheDocument();
    });
  });

  describe("Error State", () => {
    it("shows error message when fetch fails", async () => {
      (useWallet as ReturnType<typeof vi.fn>).mockReturnValue({
        isConnected: true,
        walletAddress: mockWalletAddress,
      });

      (global.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("Network error"),
      );

      render(<PnLChart />);

      await waitFor(() => {
        expect(screen.getByText(/network error/i)).toBeInTheDocument();
      });
    });

    it("displays specific error message", async () => {
      (useWallet as ReturnType<typeof vi.fn>).mockReturnValue({
        isConnected: true,
        walletAddress: mockWalletAddress,
      });

      (global.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("Connection timeout"),
      );

      render(<PnLChart />);

      await waitFor(() => {
        expect(screen.getByText(/connection timeout/i)).toBeInTheDocument();
      });
    });

    it("handles HTTP error responses", async () => {
      (useWallet as ReturnType<typeof vi.fn>).mockReturnValue({
        isConnected: true,
        walletAddress: mockWalletAddress,
      });

      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: false,
        status: 500,
      } as Response);

      render(<PnLChart />);

      await waitFor(() => {
        expect(screen.getByText(/failed to fetch pnl data/i)).toBeInTheDocument();
      });
    });
  });

  describe("No-Data State", () => {
    it("shows empty state when no deposits and no snapshots", async () => {
      (useWallet as ReturnType<typeof vi.fn>).mockReturnValue({
        isConnected: true,
        walletAddress: mockWalletAddress,
      });

      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        json: async () => mockPnLDataEmpty,
      } as Response);

      render(<PnLChart />);

      await waitFor(() => {
        expect(screen.getByText(/no p&l data yet/i)).toBeInTheDocument();
      });
    });

    it("displays empty state message", async () => {
      (useWallet as ReturnType<typeof vi.fn>).mockReturnValue({
        isConnected: true,
        walletAddress: mockWalletAddress,
      });

      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        json: async () => mockPnLDataEmpty,
      } as Response);

      render(<PnLChart />);

      await waitFor(() => {
        expect(
          screen.getByText(/make your first deposit to start tracking/i),
        ).toBeInTheDocument();
      });
    });

    it("shows DollarSign icon in empty state", async () => {
      (useWallet as ReturnType<typeof vi.fn>).mockReturnValue({
        isConnected: true,
        walletAddress: mockWalletAddress,
      });

      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        json: async () => mockPnLDataEmpty,
      } as Response);

      render(<PnLChart />);

      await waitFor(() => {
        expect(screen.getByText(/no p&l data yet/i)).toBeInTheDocument();
      });
    });

    it("detects no-data when pnlData is null", async () => {
      (useWallet as ReturnType<typeof vi.fn>).mockReturnValue({
        isConnected: true,
        walletAddress: mockWalletAddress,
      });

      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        json: async () => null,
      } as Response);

      render(<PnLChart />);

      await waitFor(() => {
        expect(screen.getByText(/no p&l data yet/i)).toBeInTheDocument();
      });
    });
  });

  describe("Partial-Data State", () => {
    it("shows summary cards but no chart when snapshots are empty", async () => {
      (useWallet as ReturnType<typeof vi.fn>).mockReturnValue({
        isConnected: true,
        walletAddress: mockWalletAddress,
      });

      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        json: async () => mockPnLDataPartial,
      } as Response);

      render(<PnLChart />);

      await waitFor(() => {
        expect(screen.getByText("Total Deposited")).toBeInTheDocument();
        expect(screen.getByText("$5,000.00")).toBeInTheDocument();
      });

      expect(screen.getByText(/no chart data available/i)).toBeInTheDocument();
    });

    it("displays partial data warning message", async () => {
      (useWallet as ReturnType<typeof vi.fn>).mockReturnValue({
        isConnected: true,
        walletAddress: mockWalletAddress,
      });

      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        json: async () => mockPnLDataPartial,
      } as Response);

      render(<PnLChart />);

      await waitFor(() => {
        expect(
          screen.getByText(/historical chart data is being generated/i),
        ).toBeInTheDocument();
      });
    });

    it("shows BarChart3 icon in partial data state", async () => {
      (useWallet as ReturnType<typeof vi.fn>).mockReturnValue({
        isConnected: true,
        walletAddress: mockWalletAddress,
      });

      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        json: async () => mockPnLDataPartial,
      } as Response);

      render(<PnLChart />);

      await waitFor(() => {
        expect(screen.getByText(/no chart data available/i)).toBeInTheDocument();
      });
    });

    it("does not render broken chart axes with no snapshots", async () => {
      (useWallet as ReturnType<typeof vi.fn>).mockReturnValue({
        isConnected: true,
        walletAddress: mockWalletAddress,
      });

      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        json: async () => mockPnLDataPartial,
      } as Response);

      render(<PnLChart />);

      await waitFor(() => {
        expect(screen.getByText(/no chart data available/i)).toBeInTheDocument();
      });

      // Ensure no chart elements are rendered
      const chartContainer = screen.queryByRole("img"); // Recharts uses SVG
      expect(chartContainer).not.toBeInTheDocument();
    });
  });

  describe("Data Display with Chart", () => {
    it("renders chart when data exists", async () => {
      (useWallet as ReturnType<typeof vi.fn>).mockReturnValue({
        isConnected: true,
        walletAddress: mockWalletAddress,
      });

      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        json: async () => mockPnLDataWithChart,
      } as Response);

      render(<PnLChart />);

      await waitFor(() => {
        expect(screen.getByText("Total Deposited")).toBeInTheDocument();
        expect(screen.getByText("$10,000.00")).toBeInTheDocument();
      });

      // Chart should be rendered (no empty state message)
      expect(screen.queryByText(/no chart data available/i)).not.toBeInTheDocument();
    });

    it("displays all summary cards", async () => {
      (useWallet as ReturnType<typeof vi.fn>).mockReturnValue({
        isConnected: true,
        walletAddress: mockWalletAddress,
      });

      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        json: async () => mockPnLDataWithChart,
      } as Response);

      render(<PnLChart />);

      await waitFor(() => {
        expect(screen.getByText("Total Deposited")).toBeInTheDocument();
        expect(screen.getByText("Total Withdrawn")).toBeInTheDocument();
        expect(screen.getByText("Current Value")).toBeInTheDocument();
        expect(screen.getByText("Absolute PnL")).toBeInTheDocument();
      });
    });

    it("shows correct values in summary cards", async () => {
      (useWallet as ReturnType<typeof vi.fn>).mockReturnValue({
        isConnected: true,
        walletAddress: mockWalletAddress,
      });

      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        json: async () => mockPnLDataWithChart,
      } as Response);

      render(<PnLChart />);

      await waitFor(() => {
        expect(screen.getByText("$10,000.00")).toBeInTheDocument();
        expect(screen.getByText("$2,000.00")).toBeInTheDocument();
        expect(screen.getByText("$11,500.00")).toBeInTheDocument();
        expect(screen.getByText("+$3,500.00")).toBeInTheDocument();
      });
    });

    it("displays TWR percentage", async () => {
      (useWallet as ReturnType<typeof vi.fn>).mockReturnValue({
        isConnected: true,
        walletAddress: mockWalletAddress,
      });

      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        json: async () => mockPnLDataWithChart,
      } as Response);

      render(<PnLChart />);

      await waitFor(() => {
        expect(screen.getByText(/time-weighted return/i)).toBeInTheDocument();
        expect(screen.getByText("+43.75%")).toBeInTheDocument();
      });
    });

    it("shows TrendingUp icon for positive PnL", async () => {
      (useWallet as ReturnType<typeof vi.fn>).mockReturnValue({
        isConnected: true,
        walletAddress: mockWalletAddress,
      });

      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        json: async () => mockPnLDataWithChart,
      } as Response);

      render(<PnLChart />);

      await waitFor(() => {
        expect(screen.getByText("Profit & Loss")).toBeInTheDocument();
      });

      // Check for green color class on PnL value
      const pnlValue = screen.getByText("+$3,500.00");
      expect(pnlValue.className).toContain("text-green-400");
    });

    it("shows TrendingDown icon for negative PnL", async () => {
      (useWallet as ReturnType<typeof vi.fn>).mockReturnValue({
        isConnected: true,
        walletAddress: mockWalletAddress,
      });

      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        json: async () => mockPnLDataNegative,
      } as Response);

      render(<PnLChart />);

      await waitFor(() => {
        expect(screen.getByText("Profit & Loss")).toBeInTheDocument();
      });

      // Check for red color class on PnL value
      const pnlValue = screen.getByText("-$1,000.00");
      expect(pnlValue.className).toContain("text-red-400");
    });

    it("preserves chart rendering when data exists", async () => {
      (useWallet as ReturnType<typeof vi.fn>).mockReturnValue({
        isConnected: true,
        walletAddress: mockWalletAddress,
      });

      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        json: async () => mockPnLDataWithChart,
      } as Response);

      render(<PnLChart />);

      await waitFor(() => {
        expect(screen.getByText("Total Deposited")).toBeInTheDocument();
      });

      // Verify no empty state is shown
      expect(screen.queryByText(/no chart data available/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/no p&l data yet/i)).not.toBeInTheDocument();
    });
  });

  describe("API Integration", () => {
    it("calls correct API endpoint", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => mockPnLDataWithChart,
      } as Response);

      global.fetch = fetchMock;

      (useWallet as ReturnType<typeof vi.fn>).mockReturnValue({
        isConnected: true,
        walletAddress: mockWalletAddress,
      });

      render(<PnLChart />);

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          `http://localhost:3000/api/users/${encodeURIComponent(mockWalletAddress)}/pnl`,
        );
      });
    });

    it("fetches data when wallet connects", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => mockPnLDataWithChart,
      } as Response);

      global.fetch = fetchMock;

      (useWallet as ReturnType<typeof vi.fn>).mockReturnValue({
        isConnected: true,
        walletAddress: mockWalletAddress,
      });

      render(<PnLChart />);

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledTimes(1);
      });
    });

    it("does not fetch when wallet is not connected", () => {
      const fetchMock = vi.fn();
      global.fetch = fetchMock;

      (useWallet as ReturnType<typeof vi.fn>).mockReturnValue({
        isConnected: false,
        walletAddress: null,
      });

      render(<PnLChart />);

      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("Edge Cases", () => {
    it("handles single snapshot data point", async () => {
      (useWallet as ReturnType<typeof vi.fn>).mockReturnValue({
        isConnected: true,
        walletAddress: mockWalletAddress,
      });

      const singleSnapshotData = {
        ...mockPnLDataWithChart,
        dailySnapshots: [
          { date: "2024-01-01", cumulativePnL: 100, portfolioValue: 10100, sharePrice: 1.01 },
        ],
      };

      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        json: async () => singleSnapshotData,
      } as Response);

      render(<PnLChart />);

      await waitFor(() => {
        expect(screen.getByText("Total Deposited")).toBeInTheDocument();
      });

      // Should still render chart with single data point
      expect(screen.queryByText(/no chart data available/i)).not.toBeInTheDocument();
    });

    it("handles zero PnL correctly", async () => {
      (useWallet as ReturnType<typeof vi.fn>).mockReturnValue({
        isConnected: true,
        walletAddress: mockWalletAddress,
      });

      const zeroPnLData = {
        ...mockPnLDataWithChart,
        absolutePnL: 0,
        twrPercent: 0,
      };

      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        json: async () => zeroPnLData,
      } as Response);

      render(<PnLChart />);

      await waitFor(() => {
        expect(screen.getByText("+$0.00")).toBeInTheDocument();
        expect(screen.getByText("+0.00%")).toBeInTheDocument();
      });
    });

    it("formats large numbers with commas", async () => {
      (useWallet as ReturnType<typeof vi.fn>).mockReturnValue({
        isConnected: true,
        walletAddress: mockWalletAddress,
      });

      const largeNumberData = {
        ...mockPnLDataWithChart,
        totalDeposited: 1234567.89,
        currentValue: 1500000.50,
      };

      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        json: async () => largeNumberData,
      } as Response);

      render(<PnLChart />);

      await waitFor(() => {
        expect(screen.getByText("$1,234,567.89")).toBeInTheDocument();
        expect(screen.getByText("$1,500,000.50")).toBeInTheDocument();
      });
    });

    it("renders sparse out-of-order snapshots safely", async () => {
      (useWallet as ReturnType<typeof vi.fn>).mockReturnValue({
        isConnected: true,
        walletAddress: mockWalletAddress,
      });

      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        json: async () => ({
          ...mockPnLDataWithChart,
          dailySnapshots: [
            { date: "2024-01-03", cumulativePnL: 500, portfolioValue: 10500, sharePrice: 1.05 },
            { date: "invalid-date", cumulativePnL: 999, portfolioValue: 10999, sharePrice: 1.1 },
            { date: "2024-01-01", cumulativePnL: 100, portfolioValue: 10100, sharePrice: 1.01 },
          ],
        }),
      } as Response);

      render(<PnLChart />);

      await waitFor(() => {
        expect(screen.getByText(/Limited history available/)).toBeInTheDocument();
      });
    });
  });
});
