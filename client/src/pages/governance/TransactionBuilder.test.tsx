import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import TransactionBuilder from "./TransactionBuilder";
import { useWallet } from "../../context/useWallet";
import type { PendingTransaction } from "./types";

// Mock the wallet context
vi.mock("../../context/useWallet", () => ({
  useWallet: vi.fn(),
}));

// Mock Stellar SDK
vi.mock("@stellar/stellar-sdk", () => ({
  BASE_FEE: "100",
  Address: class {
    constructor(public address: string) {}
    toScVal() {
      return { address: this.address };
    }
  },
  nativeToScVal: (value: bigint) => ({ value }),
  Contract: class {
    constructor(public id: string) {}
    call(method: string, ...args: unknown[]) {
      return { method, args };
    }
  },
  TransactionBuilder: class {
    constructor(public source: unknown, public options: unknown) {}
    addOperation(op: unknown) {
      return this;
    }
    setTimeout() {
      return this;
    }
    build() {
      return {
        toXDR: () => "mock_xdr_string",
      };
    }
  },
  rpc: {
    Server: class {
      async getAccount(address: string) {
        return { accountId: address };
      }
      async simulateTransaction() {
        return {
          results: [{ xdr: "mock_result" }],
        };
      }
    },
    Api: {
      isSimulationError: () => false,
    },
    assembleTransaction: (tx: unknown) => ({
      build: () => ({
        toXDR: () => "mock_assembled_xdr",
      }),
    }),
  },
}));

// Mock fetch for fee API
global.fetch = vi.fn(() =>
  Promise.resolve({
    ok: true,
    json: () => Promise.resolve({ fees: { average: 150 } }),
  } as Response),
);

describe("TransactionBuilder Validation", () => {
  const mockOnTransactionCreated = vi.fn();
  const mockWalletAddress = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

  beforeEach(() => {
    vi.clearAllMocks();
    (useWallet as ReturnType<typeof vi.fn>).mockReturnValue({
      walletAddress: mockWalletAddress,
    });
  });

  describe("Wallet and Proposal Input Validation", () => {
    it("disables build button when no wallet is connected", () => {
      (useWallet as ReturnType<typeof vi.fn>).mockReturnValue({
        walletAddress: null,
      });

      render(
        <TransactionBuilder
          threshold={2}
          contractId="CCONTRACT123"
          onTransactionCreated={mockOnTransactionCreated}
        />,
      );

      const buildButton = screen.getByRole("button", { name: /build & propose/i });
      expect(buildButton).toBeDisabled();
    });

    it("disables build button when no action is selected", () => {
      render(
        <TransactionBuilder
          threshold={2}
          contractId="CCONTRACT123"
          onTransactionCreated={mockOnTransactionCreated}
        />,
      );

      const buildButton = screen.getByRole("button", { name: /build & propose/i });
      expect(buildButton).toBeDisabled();
    });

    it("shows validation errors for required fields", () => {
      render(
        <TransactionBuilder
          threshold={2}
          contractId="CCONTRACT123"
          onTransactionCreated={mockOnTransactionCreated}
        />,
      );

      const actionSelect = screen.getByRole("combobox", { name: /action/i });
      fireEvent.change(actionSelect, { target: { value: "register_keeper" } });

      expect(screen.getByText(/keeper address is required/i)).toBeInTheDocument();
    });

    it("validates Stellar address format", () => {
      render(
        <TransactionBuilder
          threshold={2}
          contractId="CCONTRACT123"
          onTransactionCreated={mockOnTransactionCreated}
        />,
      );

      const actionSelect = screen.getByRole("combobox", { name: /action/i });
      fireEvent.change(actionSelect, { target: { value: "register_keeper" } });

      const addressInput = screen.getByPlaceholderText("G...");
      fireEvent.change(addressInput, { target: { value: "invalid_address" } });

      expect(
        screen.getByText(/keeper address must be a valid stellar address/i),
      ).toBeInTheDocument();
    });

    it("validates number fields are positive", () => {
      render(
        <TransactionBuilder
          threshold={2}
          contractId="CCONTRACT123"
          onTransactionCreated={mockOnTransactionCreated}
        />,
      );

      const actionSelect = screen.getByRole("combobox", { name: /action/i });
      fireEvent.change(actionSelect, { target: { value: "set_keeper_fee" } });

      const feeInput = screen.getByPlaceholderText("50");
      fireEvent.change(feeInput, { target: { value: "-100" } });

      expect(
        screen.getByText(/fee \(bps\) must be between 0 and 10000/i),
      ).toBeInTheDocument();
    });

    it("validates fee bounds range (0-10000 bps)", () => {
      render(
        <TransactionBuilder
          threshold={2}
          contractId="CCONTRACT123"
          onTransactionCreated={mockOnTransactionCreated}
        />,
      );

      const actionSelect = screen.getByRole("combobox", { name: /action/i });
      fireEvent.change(actionSelect, { target: { value: "set_keeper_fee" } });

      const feeInput = screen.getByPlaceholderText("50");
      fireEvent.change(feeInput, { target: { value: "15000" } });

      expect(
        screen.getByText(/fee \(bps\) must be between 0 and 10000/i),
      ).toBeInTheDocument();
    });

    it("validates min fee is less than max fee", () => {
      render(
        <TransactionBuilder
          threshold={2}
          contractId="CCONTRACT123"
          onTransactionCreated={mockOnTransactionCreated}
        />,
      );

      const actionSelect = screen.getByRole("combobox", { name: /action/i });
      fireEvent.change(actionSelect, { target: { value: "set_fee_bounds" } });

      const minInput = screen.getByPlaceholderText("100");
      const maxInput = screen.getByPlaceholderText("1000");

      fireEvent.change(minInput, { target: { value: "500" } });
      fireEvent.change(maxInput, { target: { value: "300" } });

      expect(
        screen.getByText(/max fee must be greater than min fee/i),
      ).toBeInTheDocument();
    });

    it("validates rescue funds amount is greater than 0", () => {
      render(
        <TransactionBuilder
          threshold={2}
          contractId="CCONTRACT123"
          onTransactionCreated={mockOnTransactionCreated}
        />,
      );

      const actionSelect = screen.getByRole("combobox", { name: /action/i });
      fireEvent.change(actionSelect, { target: { value: "rescue_funds" } });

      const amountInput = screen.getByPlaceholderText("1000000");
      fireEvent.change(amountInput, { target: { value: "0" } });

      expect(
        screen.getByText(/amount \(stroops\) must be greater than 0/i),
      ).toBeInTheDocument();
    });
  });

  describe("Validation Summary Display", () => {
    it("shows validation summary when action is selected", () => {
      render(
        <TransactionBuilder
          threshold={2}
          contractId="CCONTRACT123"
          onTransactionCreated={mockOnTransactionCreated}
        />,
      );

      const actionSelect = screen.getByRole("combobox", { name: /action/i });
      fireEvent.change(actionSelect, { target: { value: "emergency_pause" } });

      expect(screen.getByText(/ready to build/i)).toBeInTheDocument();
    });

    it("displays action name in summary", () => {
      render(
        <TransactionBuilder
          threshold={2}
          contractId="CCONTRACT123"
          onTransactionCreated={mockOnTransactionCreated}
        />,
      );

      const actionSelect = screen.getByRole("combobox", { name: /action/i });
      fireEvent.change(actionSelect, { target: { value: "emergency_pause" } });

      expect(screen.getByText("Action:")).toBeInTheDocument();
      expect(screen.getByText("Emergency Pause")).toBeInTheDocument();
    });

    it("displays target information for keeper registration", () => {
      render(
        <TransactionBuilder
          threshold={2}
          contractId="CCONTRACT123"
          onTransactionCreated={mockOnTransactionCreated}
        />,
      );

      const actionSelect = screen.getByRole("combobox", { name: /action/i });
      fireEvent.change(actionSelect, { target: { value: "register_keeper" } });

      const addressInput = screen.getByPlaceholderText("G...");
      fireEvent.change(addressInput, {
        target: { value: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB" },
      });

      expect(screen.getByText("Target:")).toBeInTheDocument();
      expect(screen.getByText(/GBBBBBB\.\.\./)).toBeInTheDocument();
    });

    it("displays critical risk level for emergency pause", () => {
      render(
        <TransactionBuilder
          threshold={2}
          contractId="CCONTRACT123"
          onTransactionCreated={mockOnTransactionCreated}
        />,
      );

      const actionSelect = screen.getByRole("combobox", { name: /action/i });
      fireEvent.change(actionSelect, { target: { value: "emergency_pause" } });

      expect(screen.getByText("Risk Level:")).toBeInTheDocument();
      expect(screen.getByText("CRITICAL")).toBeInTheDocument();
    });

    it("displays high risk level for remove keeper", () => {
      render(
        <TransactionBuilder
          threshold={2}
          contractId="CCONTRACT123"
          onTransactionCreated={mockOnTransactionCreated}
        />,
      );

      const actionSelect = screen.getByRole("combobox", { name: /action/i });
      fireEvent.change(actionSelect, { target: { value: "remove_keeper" } });

      expect(screen.getByText("Risk Level:")).toBeInTheDocument();
      expect(screen.getByText("HIGH")).toBeInTheDocument();
    });

    it("displays medium risk level for register keeper", () => {
      render(
        <TransactionBuilder
          threshold={2}
          contractId="CCONTRACT123"
          onTransactionCreated={mockOnTransactionCreated}
        />,
      );

      const actionSelect = screen.getByRole("combobox", { name: /action/i });
      fireEvent.change(actionSelect, { target: { value: "register_keeper" } });

      const addressInput = screen.getByPlaceholderText("G...");
      fireEvent.change(addressInput, {
        target: { value: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB" },
      });

      expect(screen.getByText("Risk Level:")).toBeInTheDocument();
      expect(screen.getByText("MEDIUM")).toBeInTheDocument();
    });

    it("shows validation required when form is invalid", () => {
      render(
        <TransactionBuilder
          threshold={2}
          contractId="CCONTRACT123"
          onTransactionCreated={mockOnTransactionCreated}
        />,
      );

      const actionSelect = screen.getByRole("combobox", { name: /action/i });
      fireEvent.change(actionSelect, { target: { value: "register_keeper" } });

      expect(screen.getByText(/validation required/i)).toBeInTheDocument();
    });
  });

  describe("Build Button State", () => {
    it("disables build button when validation fails", () => {
      render(
        <TransactionBuilder
          threshold={2}
          contractId="CCONTRACT123"
          onTransactionCreated={mockOnTransactionCreated}
        />,
      );

      const actionSelect = screen.getByRole("combobox", { name: /action/i });
      fireEvent.change(actionSelect, { target: { value: "register_keeper" } });

      const buildButton = screen.getByRole("button", { name: /build & propose/i });
      expect(buildButton).toBeDisabled();
    });

    it("enables build button when all validations pass", () => {
      render(
        <TransactionBuilder
          threshold={2}
          contractId="CCONTRACT123"
          onTransactionCreated={mockOnTransactionCreated}
        />,
      );

      const actionSelect = screen.getByRole("combobox", { name: /action/i });
      fireEvent.change(actionSelect, { target: { value: "register_keeper" } });

      const addressInput = screen.getByPlaceholderText("G...");
      fireEvent.change(addressInput, {
        target: { value: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB" },
      });

      const buildButton = screen.getByRole("button", { name: /build & propose/i });
      expect(buildButton).not.toBeDisabled();
    });

    it("disables build button while building transaction", async () => {
      render(
        <TransactionBuilder
          threshold={2}
          contractId="CCONTRACT123"
          onTransactionCreated={mockOnTransactionCreated}
        />,
      );

      const actionSelect = screen.getByRole("combobox", { name: /action/i });
      fireEvent.change(actionSelect, { target: { value: "emergency_pause" } });

      const buildButton = screen.getByRole("button", { name: /build & propose/i });
      fireEvent.click(buildButton);

      await waitFor(() => {
        expect(screen.getByText(/building transaction\.\.\./i)).toBeInTheDocument();
      });
    });
  });

  describe("Valid Form States", () => {
    it("accepts valid emergency pause action", () => {
      render(
        <TransactionBuilder
          threshold={2}
          contractId="CCONTRACT123"
          onTransactionCreated={mockOnTransactionCreated}
        />,
      );

      const actionSelect = screen.getByRole("combobox", { name: /action/i });
      fireEvent.change(actionSelect, { target: { value: "emergency_pause" } });

      expect(screen.getByText(/ready to build/i)).toBeInTheDocument();
      const buildButton = screen.getByRole("button", { name: /build & propose/i });
      expect(buildButton).not.toBeDisabled();
    });

    it("accepts valid keeper registration with proper address", () => {
      render(
        <TransactionBuilder
          threshold={2}
          contractId="CCONTRACT123"
          onTransactionCreated={mockOnTransactionCreated}
        />,
      );

      const actionSelect = screen.getByRole("combobox", { name: /action/i });
      fireEvent.change(actionSelect, { target: { value: "register_keeper" } });

      const addressInput = screen.getByPlaceholderText("G...");
      fireEvent.change(addressInput, {
        target: { value: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB" },
      });

      expect(screen.getByText(/ready to build/i)).toBeInTheDocument();
      const buildButton = screen.getByRole("button", { name: /build & propose/i });
      expect(buildButton).not.toBeDisabled();
    });

    it("accepts valid fee bounds with min < max", () => {
      render(
        <TransactionBuilder
          threshold={2}
          contractId="CCONTRACT123"
          onTransactionCreated={mockOnTransactionCreated}
        />,
      );

      const actionSelect = screen.getByRole("combobox", { name: /action/i });
      fireEvent.change(actionSelect, { target: { value: "set_fee_bounds" } });

      const minInput = screen.getByPlaceholderText("100");
      const maxInput = screen.getByPlaceholderText("1000");

      fireEvent.change(minInput, { target: { value: "100" } });
      fireEvent.change(maxInput, { target: { value: "1000" } });

      expect(screen.getByText(/ready to build/i)).toBeInTheDocument();
      const buildButton = screen.getByRole("button", { name: /build & propose/i });
      expect(buildButton).not.toBeDisabled();
    });

    it("accepts valid rescue funds with address and amount", () => {
      render(
        <TransactionBuilder
          threshold={2}
          contractId="CCONTRACT123"
          onTransactionCreated={mockOnTransactionCreated}
        />,
      );

      const actionSelect = screen.getByRole("combobox", { name: /action/i });
      fireEvent.change(actionSelect, { target: { value: "rescue_funds" } });

      const targetInput = screen.getByPlaceholderText("G...");
      const amountInput = screen.getByPlaceholderText("1000000");

      fireEvent.change(targetInput, {
        target: { value: "GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC" },
      });
      fireEvent.change(amountInput, { target: { value: "5000000" } });

      expect(screen.getByText(/ready to build/i)).toBeInTheDocument();
      const buildButton = screen.getByRole("button", { name: /build & propose/i });
      expect(buildButton).not.toBeDisabled();
    });

    it("accepts valid keeper fee within bounds", () => {
      render(
        <TransactionBuilder
          threshold={2}
          contractId="CCONTRACT123"
          onTransactionCreated={mockOnTransactionCreated}
        />,
      );

      const actionSelect = screen.getByRole("combobox", { name: /action/i });
      fireEvent.change(actionSelect, { target: { value: "set_keeper_fee" } });

      const feeInput = screen.getByPlaceholderText("50");
      fireEvent.change(feeInput, { target: { value: "75" } });

      expect(screen.getByText(/ready to build/i)).toBeInTheDocument();
      const buildButton = screen.getByRole("button", { name: /build & propose/i });
      expect(buildButton).not.toBeDisabled();
    });
  });

  describe("Invalid Form States", () => {
    it("rejects keeper registration with invalid address", () => {
      render(
        <TransactionBuilder
          threshold={2}
          contractId="CCONTRACT123"
          onTransactionCreated={mockOnTransactionCreated}
        />,
      );

      const actionSelect = screen.getByRole("combobox", { name: /action/i });
      fireEvent.change(actionSelect, { target: { value: "register_keeper" } });

      const addressInput = screen.getByPlaceholderText("G...");
      fireEvent.change(addressInput, { target: { value: "INVALID" } });

      expect(screen.getByText(/validation required/i)).toBeInTheDocument();
      const buildButton = screen.getByRole("button", { name: /build & propose/i });
      expect(buildButton).toBeDisabled();
    });

    it("rejects fee bounds when min >= max", () => {
      render(
        <TransactionBuilder
          threshold={2}
          contractId="CCONTRACT123"
          onTransactionCreated={mockOnTransactionCreated}
        />,
      );

      const actionSelect = screen.getByRole("combobox", { name: /action/i });
      fireEvent.change(actionSelect, { target: { value: "set_fee_bounds" } });

      const minInput = screen.getByPlaceholderText("100");
      const maxInput = screen.getByPlaceholderText("1000");

      fireEvent.change(minInput, { target: { value: "1000" } });
      fireEvent.change(maxInput, { target: { value: "1000" } });

      expect(screen.getByText(/max fee must be greater than min fee/i)).toBeInTheDocument();
      const buildButton = screen.getByRole("button", { name: /build & propose/i });
      expect(buildButton).toBeDisabled();
    });

    it("rejects rescue funds with zero amount", () => {
      render(
        <TransactionBuilder
          threshold={2}
          contractId="CCONTRACT123"
          onTransactionCreated={mockOnTransactionCreated}
        />,
      );

      const actionSelect = screen.getByRole("combobox", { name: /action/i });
      fireEvent.change(actionSelect, { target: { value: "rescue_funds" } });

      const targetInput = screen.getByPlaceholderText("G...");
      const amountInput = screen.getByPlaceholderText("1000000");

      fireEvent.change(targetInput, {
        target: { value: "GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC" },
      });
      fireEvent.change(amountInput, { target: { value: "0" } });

      expect(
        screen.getByText(/amount \(stroops\) must be greater than 0/i),
      ).toBeInTheDocument();
      const buildButton = screen.getByRole("button", { name: /build & propose/i });
      expect(buildButton).toBeDisabled();
    });

    it("rejects keeper fee outside valid range", () => {
      render(
        <TransactionBuilder
          threshold={2}
          contractId="CCONTRACT123"
          onTransactionCreated={mockOnTransactionCreated}
        />,
      );

      const actionSelect = screen.getByRole("combobox", { name: /action/i });
      fireEvent.change(actionSelect, { target: { value: "set_keeper_fee" } });

      const feeInput = screen.getByPlaceholderText("50");
      fireEvent.change(feeInput, { target: { value: "20000" } });

      expect(
        screen.getByText(/fee \(bps\) must be between 0 and 10000/i),
      ).toBeInTheDocument();
      const buildButton = screen.getByRole("button", { name: /build & propose/i });
      expect(buildButton).toBeDisabled();
    });

    it("rejects empty required fields", () => {
      render(
        <TransactionBuilder
          threshold={2}
          contractId="CCONTRACT123"
          onTransactionCreated={mockOnTransactionCreated}
        />,
      );

      const actionSelect = screen.getByRole("combobox", { name: /action/i });
      fireEvent.change(actionSelect, { target: { value: "set_admin" } });

      expect(screen.getByText(/new admin address is required/i)).toBeInTheDocument();
      const buildButton = screen.getByRole("button", { name: /build & propose/i });
      expect(buildButton).toBeDisabled();
    });
  });

  describe("Transaction Creation", () => {
    it("creates transaction with valid inputs", async () => {
      render(
        <TransactionBuilder
          threshold={2}
          contractId="CCONTRACT123"
          onTransactionCreated={mockOnTransactionCreated}
        />,
      );

      const actionSelect = screen.getByRole("combobox", { name: /action/i });
      fireEvent.change(actionSelect, { target: { value: "emergency_pause" } });

      const buildButton = screen.getByRole("button", { name: /build & propose/i });
      fireEvent.click(buildButton);

      await waitFor(() => {
        expect(mockOnTransactionCreated).toHaveBeenCalledWith(
          expect.objectContaining({
            method: "emergency_pause",
            threshold: 2,
            status: "pending",
          }),
        );
      });
    });

    it("resets form after successful transaction creation", async () => {
      render(
        <TransactionBuilder
          threshold={2}
          contractId="CCONTRACT123"
          onTransactionCreated={mockOnTransactionCreated}
        />,
      );

      const actionSelect = screen.getByRole("combobox", { name: /action/i });
      fireEvent.change(actionSelect, { target: { value: "emergency_pause" } });

      const buildButton = screen.getByRole("button", { name: /build & propose/i });
      fireEvent.click(buildButton);

      await waitFor(() => {
        expect(mockOnTransactionCreated).toHaveBeenCalled();
      });

      expect(actionSelect).toHaveValue("");
    });
  });
});
