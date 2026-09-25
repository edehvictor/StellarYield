import { render, screen, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import YieldForGood from "./YieldForGood";
import { useWallet } from "../../context/useWallet";

// Mock useWallet hook
vi.mock("../../context/useWallet", () => ({
    useWallet: vi.fn(),
}));

// Mock API base URL
vi.mock("../../lib/api", () => ({
    getApiBaseUrl: () => "http://localhost:3000",
}));

describe("YieldForGood Summary Formatting", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        global.fetch = vi.fn();
    });

    it("renders zero-donation state gracefully", async () => {
        (useWallet as any).mockReturnValue({ isConnected: true, walletAddress: "G123" });
        
        (global.fetch as any).mockImplementation((url: string) => {
            if (url.includes("/api/donations/summary")) {
                return Promise.resolve({
                    ok: true,
                    json: () => Promise.resolve({ totalDonated: 0, participatingVaults: 0, projectedMonthlyImpact: 0 }),
                });
            }
            if (url.includes("/api/donations/config")) {
                return Promise.resolve({
                    ok: true,
                    json: () => Promise.resolve({ bps: 0, charityId: null }),
                });
            }
            return Promise.reject(new Error("Unknown URL"));
        });

        render(<YieldForGood />);

        await waitFor(() => {
            expect(screen.getByText("Total Donated")).toBeDefined();
        });

        // Check if zero values are rendered correctly
        expect(screen.getAllByText("0")).toHaveLength(2); // Total Donated and Active Donors
        expect(screen.getByText("+$0")).toBeDefined(); // Monthly Impact
    });

    it("formats large numbers correctly in summary cards", async () => {
        (useWallet as any).mockReturnValue({ isConnected: true, walletAddress: "G123" });
        
        (global.fetch as any).mockImplementation((url: string) => {
            if (url.includes("/api/donations/summary")) {
                return Promise.resolve({
                    ok: true,
                    json: () => Promise.resolve({ 
                        totalDonated: 1250000, 
                        participatingVaults: 42, 
                        projectedMonthlyImpact: 15400.50 
                    }),
                });
            }
            if (url.includes("/api/donations/config")) {
                return Promise.resolve({
                    ok: true,
                    json: () => Promise.resolve({ bps: 500, charityId: "open-source-fund" }),
                });
            }
            return Promise.reject(new Error("Unknown URL"));
        });

        render(<YieldForGood />);

        await waitFor(() => {
            expect(screen.getByText("1,250,000")).toBeDefined();
            expect(screen.getByText("42")).toBeDefined();
            expect(screen.getByText("+$15,400.5")).toBeDefined();
        });
    });
});
