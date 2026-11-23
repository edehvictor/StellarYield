import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    getContractId: vi.fn(),
    validateContractRegistryEntry: vi.fn(),
    getAccount: vi.fn(),
    simulateTransaction: vi.fn(),
    sendTransaction: vi.fn(),
    getTransaction: vi.fn(),
    signTransaction: vi.fn(),
}));

vi.mock("../../services/contractRegistry", () => ({
    getContractId: mocks.getContractId,
    validateContractRegistryEntry: mocks.validateContractRegistryEntry,
}));

vi.mock("../../services/soroban", () => ({
    RPC_URL: "https://example.invalid",
    NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
}));

vi.mock("@stellar/freighter-api", () => ({
    default: {
        signTransaction: mocks.signTransaction,
    },
}));

vi.mock("@stellar/stellar-sdk", () => {
    class MockTransactionBuilder {
        addOperation() {
            return this;
        }

        setTimeout() {
            return this;
        }

        build() {
            return {
                toXDR: () => "transaction-xdr",
            };
        }

        static fromXDR() {
            return { signed: true };
        }
    }

    class MockContract {
        call() {
            return {};
        }
    }

    class MockServer {
        getAccount = mocks.getAccount;
        simulateTransaction = mocks.simulateTransaction;
        sendTransaction = mocks.sendTransaction;
        getTransaction = mocks.getTransaction;
    }

    return {
        BASE_FEE: "100",
        Contract: MockContract,
        TransactionBuilder: MockTransactionBuilder,
        nativeToScVal: vi.fn(() => ({})),
        rpc: {
            Server: MockServer,
            Api: {
                isSimulationError: (value: { error?: string }) =>
                    Boolean(value?.error),
                GetTransactionStatus: {
                    SUCCESS: "SUCCESS",
                    FAILED: "FAILED",
                },
            },
            assembleTransaction: () => ({
                build: () => ({
                    toXDR: () => "prepared-xdr",
                }),
            }),
        },
    };
});

import { claimVested } from "./vestingService";

const WALLET = "GTESTWALLET";
const HASH = "transaction-hash";

beforeEach(() => {
    vi.clearAllMocks();

    mocks.getContractId.mockReturnValue("CTESTCONTRACT");
    mocks.getAccount.mockResolvedValue({});
    mocks.simulateTransaction.mockResolvedValue({});
    mocks.signTransaction.mockResolvedValue({
        signedTxXdr: "signed-xdr",
    });
    mocks.sendTransaction.mockResolvedValue({
        status: "PENDING",
        hash: HASH,
    });
    mocks.getTransaction.mockResolvedValue({
        status: "SUCCESS",
    });
});

describe("vesting claim concurrency", () => {
    it("submits only one transaction for simultaneous claims", async () => {
        let releaseAccount!: (value: unknown) => void;

        mocks.getAccount.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    releaseAccount = resolve;
                }),
        );

        const first = claimVested(WALLET);
        const second = claimVested(WALLET);

        releaseAccount({});

        const results = await Promise.all([first, second]);

        expect(results[0].success).toBe(true);
        expect(results[1].success).toBe(true);
        expect(mocks.sendTransaction).toHaveBeenCalledTimes(1);
        expect(mocks.signTransaction).toHaveBeenCalledTimes(1);
    });

    it("does not submit when simulation fails", async () => {
        mocks.simulateTransaction.mockResolvedValueOnce({
            error: "Simulation failed",
        });

        const result = await claimVested(WALLET);

        expect(result.success).toBe(false);
        expect(mocks.signTransaction).not.toHaveBeenCalled();
        expect(mocks.sendTransaction).not.toHaveBeenCalled();
    });

    it("allows a retry after a definitive simulation failure", async () => {
        mocks.simulateTransaction
            .mockResolvedValueOnce({ error: "Simulation failed" })
            .mockResolvedValueOnce({});

        const first = await claimVested(WALLET);
        const second = await claimVested(WALLET);

        expect(first.success).toBe(false);
        expect(second.success).toBe(true);
        expect(mocks.sendTransaction).toHaveBeenCalledTimes(1);
    });

    it("does not submit when wallet signing fails", async () => {
        mocks.signTransaction.mockResolvedValueOnce({
            error: { message: "User rejected signing" },
        });

        const result = await claimVested(WALLET);

        expect(result.success).toBe(false);
        expect(mocks.sendTransaction).not.toHaveBeenCalled();
    });

    it("reconciles an unresolved transaction before retrying", async () => {
        mocks.getTransaction
            .mockRejectedValueOnce(new Error("RPC unavailable"))
            .mockResolvedValueOnce({ status: "SUCCESS" });

        const first = await claimVested(WALLET);

        expect(first.success).toBe(false);
        expect(first.pending).toBe(true);
        expect(first.hash).toBe(HASH);

        const second = await claimVested(WALLET);

        expect(second.success).toBe(true);
        expect(second.hash).toBe(HASH);
        expect(mocks.sendTransaction).toHaveBeenCalledTimes(1);
    });
});