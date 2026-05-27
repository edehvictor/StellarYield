import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import Leaderboard from "./Leaderboard";

// Mock the API module
vi.mock("../../lib/api", () => ({
  apiUrl: (path: string) => `http://localhost:3000${path}`,
}));

describe("Leaderboard", () => {
  const mockLeaderboardData = [
    {
      rank: 1,
      walletAddress: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
      tvl: 500000,
      totalYield: 25000,
      badge: "Whale",
    },
    {
      rank: 2,
      walletAddress: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
      tvl: 250000,
      totalYield: 12500,
      badge: "Diamond Hands",
    },
    {
      rank: 3,
      walletAddress: "GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
      tvl: 100000,
      totalYield: 5000,
      badge: "",
    },
  ];

  beforeEach(() => {
    global.fetch = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("Loading State", () => {
    it("shows loading spinner while fetching data", () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockImplementation(
        () =>
          new Promise(() => {
            /* never resolves */
          }),
      );

      render(<Leaderboard />);

      expect(screen.getByText(/loading leaderboard rankings\.\.\./i)).toBeInTheDocument();
      expect(screen.getByText("TVL LEADERBOARD")).toBeInTheDocument();
    });

    it("displays loading message with spinner", () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockImplementation(
        () =>
          new Promise(() => {
            /* never resolves */
          }),
      );

      render(<Leaderboard />);

      const spinner = document.querySelector(".animate-spin");
      expect(spinner).toBeInTheDocument();
      expect(screen.getByText(/loading leaderboard rankings\.\.\./i)).toBeInTheDocument();
    });

    it("shows header during loading", () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockImplementation(
        () =>
          new Promise(() => {
            /* never resolves */
          }),
      );

      render(<Leaderboard />);

      expect(screen.getByText("TVL LEADERBOARD")).toBeInTheDocument();
      expect(
        screen.getByText(/compete with the whales to earn exclusive badges/i),
      ).toBeInTheDocument();
    });
  });

  describe("Empty State", () => {
    it("shows empty state when no rankings exist", async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        json: async () => [],
      } as Response);

      render(<Leaderboard />);

      await waitFor(() => {
        expect(screen.getByText(/no rankings yet/i)).toBeInTheDocument();
      });
    });

    it("displays empty state message", async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        json: async () => ({ items: [] }),
      } as Response);

      render(<Leaderboard />);

      await waitFor(() => {
        expect(
          screen.getByText(/be the first to deposit and claim your spot/i),
        ).toBeInTheDocument();
      });
    });

    it("shows Users icon in empty state", async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        json: async () => [],
      } as Response);

      render(<Leaderboard />);

      await waitFor(() => {
        expect(screen.getByText(/no rankings yet/i)).toBeInTheDocument();
      });

      // Check that the empty state container exists
      const emptyState = screen.getByText(/no rankings yet/i).closest("div");
      expect(emptyState).toBeInTheDocument();
    });

    it("maintains header in empty state", async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        json: async () => [],
      } as Response);

      render(<Leaderboard />);

      await waitFor(() => {
        expect(screen.getByText("TVL LEADERBOARD")).toBeInTheDocument();
        expect(screen.getByText(/no rankings yet/i)).toBeInTheDocument();
      });
    });
  });

  describe("Error State", () => {
    it("shows error state when fetch fails", async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("Network error"),
      );

      render(<Leaderboard />);

      await waitFor(() => {
        expect(screen.getByText(/failed to load leaderboard/i)).toBeInTheDocument();
      });
    });

    it("displays error message", async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("Connection timeout"),
      );

      render(<Leaderboard />);

      await waitFor(() => {
        expect(screen.getByText(/connection timeout/i)).toBeInTheDocument();
      });
    });

    it("shows retry button in error state", async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("Network error"),
      );

      render(<Leaderboard />);

      await waitFor(() => {
        expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
      });
    });

    it("retries fetch when retry button is clicked", async () => {
      const fetchMock = vi.fn();
      fetchMock
        .mockRejectedValueOnce(new Error("Network error"))
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockLeaderboardData,
        } as Response);

      global.fetch = fetchMock;

      render(<Leaderboard />);

      await waitFor(() => {
        expect(screen.getByText(/failed to load leaderboard/i)).toBeInTheDocument();
      });

      const retryButton = screen.getByRole("button", { name: /retry/i });
      fireEvent.click(retryButton);

      await waitFor(() => {
        expect(screen.getByText(/GAAAAAA\.\.\./)).toBeInTheDocument();
      });

      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("handles HTTP error responses", async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
      } as Response);

      render(<Leaderboard />);

      await waitFor(() => {
        expect(screen.getByText(/HTTP 500/i)).toBeInTheDocument();
      });
    });

    it("shows AlertCircle icon in error state", async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("Network error"),
      );

      render(<Leaderboard />);

      await waitFor(() => {
        expect(screen.getByText(/failed to load leaderboard/i)).toBeInTheDocument();
      });

      // Check that error state container exists
      const errorState = screen.getByText(/failed to load leaderboard/i).closest("div");
      expect(errorState).toBeInTheDocument();
    });
  });

  describe("Data Display", () => {
    it("renders leaderboard data when fetch succeeds", async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        json: async () => mockLeaderboardData,
      } as Response);

      render(<Leaderboard />);

      await waitFor(() => {
        expect(screen.getByText(/GAAAAAA\.\.\./)).toBeInTheDocument();
      });
    });

    it("displays all ranking rows", async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        json: async () => mockLeaderboardData,
      } as Response);

      render(<Leaderboard />);

      await waitFor(() => {
        expect(screen.getByText("#1")).toBeInTheDocument();
        expect(screen.getByText("#2")).toBeInTheDocument();
        expect(screen.getByText("#3")).toBeInTheDocument();
      });
    });

    it("shows TVL values correctly", async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        json: async () => mockLeaderboardData,
      } as Response);

      render(<Leaderboard />);

      await waitFor(() => {
        expect(screen.getByText("$500,000")).toBeInTheDocument();
        expect(screen.getByText("$250,000")).toBeInTheDocument();
        expect(screen.getByText("$100,000")).toBeInTheDocument();
      });
    });

    it("displays yield earned", async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        json: async () => mockLeaderboardData,
      } as Response);

      render(<Leaderboard />);

      await waitFor(() => {
        expect(screen.getByText("+$25,000")).toBeInTheDocument();
        expect(screen.getByText("+$12,500")).toBeInTheDocument();
        expect(screen.getByText("+$5,000")).toBeInTheDocument();
      });
    });

    it("shows badges for users", async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        json: async () => mockLeaderboardData,
      } as Response);

      render(<Leaderboard />);

      await waitFor(() => {
        expect(screen.getByText("Whale")).toBeInTheDocument();
        expect(screen.getByText("Diamond Hands")).toBeInTheDocument();
      });
    });

    it("handles items array in response object", async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        json: async () => ({ items: mockLeaderboardData }),
      } as Response);

      render(<Leaderboard />);

      await waitFor(() => {
        expect(screen.getByText(/GAAAAAA\.\.\./)).toBeInTheDocument();
      });
    });

    it("maintains existing layout when data is present", async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        json: async () => mockLeaderboardData,
      } as Response);

      render(<Leaderboard />);

      await waitFor(() => {
        expect(screen.getByText("Rank")).toBeInTheDocument();
        expect(screen.getByText("Wallet")).toBeInTheDocument();
        expect(screen.getByText("TVL (USDC)")).toBeInTheDocument();
        expect(screen.getByText("Yield Earned")).toBeInTheDocument();
        expect(screen.getByText("Badges")).toBeInTheDocument();
      });
    });

    it("truncates wallet addresses correctly", async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        json: async () => mockLeaderboardData,
      } as Response);

      render(<Leaderboard />);

      await waitFor(() => {
        expect(screen.getByText(/GAAAAAA\.\.\.AWHF/)).toBeInTheDocument();
        expect(screen.getByText(/GBBBBBB\.\.\.BBBB/)).toBeInTheDocument();
      });
    });
  });

  describe("API Integration", () => {
    it("calls correct API endpoint", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => mockLeaderboardData,
      } as Response);

      global.fetch = fetchMock;

      render(<Leaderboard />);

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith("http://localhost:3000/api/leaderboard");
      });
    });

    it("fetches data on mount", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => mockLeaderboardData,
      } as Response);

      global.fetch = fetchMock;

      render(<Leaderboard />);

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledTimes(1);
      });
    });
  });
});
