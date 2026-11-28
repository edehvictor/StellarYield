import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    contractId: "CTESTCONTRACT",
    passphrase: "Test SDF Network ; September 2015",
    rpcUrl: "https://example.invalid",
    getAccount: vi.fn(),
    simulateTransaction: vi.fn(),
    sendTransaction: vi.fn(),
    getTransaction: vi.fn(),
    signTransaction: vi.fn(),
    validate: vi.fn(),
}));

vi.mock("../../services/contractRegistry", () => ({
    getContractId: () => mocks.contractId,
    validateContractRegistryEntry: mocks.validate,
}));

vi.mock("../../lib/networkEnv", () => ({
    getNetworkPassphrase: () => mocks.passphrase,
    getRpcUrl: () => mocks.rpcUrl,
}));

vi.mock("../../services/soroban", () => ({
    RPC_URL: "https://example.invalid",
    NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
}));

vi.mock("@stellar/freighter-api", () => ({
    default: { signTransaction: mocks.signTransaction },
}));

vi.mock("@stellar/stellar-sdk", () => {
    class MockTransactionBuilder {
        addOperation() { return this; }
        setTimeout() { return this; }
        build() { return { toXDR: () => "unsigned-xdr" }; }
        static fromXDR() { return { signed: true }; }
    }
    class MockContract { call() { return {}; } }
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
                isSimulationError: (value: { error?: string }) => Boolean(value?.error),
                GetTransactionStatus: { SUCCESS: "SUCCESS", FAILED: "FAILED" },
            },
            assembleTransaction: () => ({ build: () => ({ toXDR: () => "prepared-xdr" }) }),
        },
    };
});

import { captureVestingClaimConfiguration, claimVested } from "./vestingService";

const WALLET = "GTESTWALLET";

beforeEach(() => {
    vi.clearAllMocks();
    mocks.contractId = "CTESTCONTRACT";
    mocks.passphrase = "Test SDF Network ; September 2015";
    mocks.rpcUrl = "https://example.invalid";
    mocks.getAccount.mockResolvedValue({});
    mocks.simulateTransaction.mockResolvedValue({});
    mocks.signTransaction.mockResolvedValue({ signedTxXdr: "signed-xdr" });
    mocks.sendTransaction.mockResolvedValue({ status: "PENDING", hash: "claim-hash" });
    mocks.getTransaction.mockResolvedValue({ status: "SUCCESS" });
});

describe("vesting claim configuration snapshots", () => {
    it("captures an immutable deterministic fingerprint", () => {
        const first = captureVestingClaimConfiguration();
        const second = captureVestingClaimConfiguration();
        expect(Object.isFrozen(first)).toBe(true);
        expect(first.fingerprint).toBe(second.fingerprint);
        mocks.contractId = "CNEWCONTRACT";
        expect(captureVestingClaimConfiguration().fingerprint).not.toBe(first.fingerprint);
        expect(first.contractId).toBe("CTESTCONTRACT");
    });

    it("submits normally when configuration remains unchanged", async () => {
        const result = await claimVested(WALLET);
        expect(result).toEqual({ success: true, hash: "claim-hash" });
        expect(mocks.sendTransaction).toHaveBeenCalledTimes(1);
    });

    it("rejects a stale snapshot after wallet signing without submitting", async () => {
        mocks.signTransaction.mockImplementationOnce(async () => {
            mocks.contractId = "CNEWCONTRACT";
            return { signedTxXdr: "signed-xdr" };
        });
        const result = await claimVested(WALLET);
        expect(result.success).toBe(false);
        expect(result.error).toMatch(/configuration changed/i);
        expect(mocks.sendTransaction).not.toHaveBeenCalled();
    });

    it("allows a fresh retry after a stale configuration failure", async () => {
        mocks.signTransaction.mockImplementationOnce(async () => {
            mocks.contractId = "CNEWCONTRACT";
            return { signedTxXdr: "signed-xdr" };
        });
        const first = await claimVested(WALLET);
        const second = await claimVested(WALLET);
        expect(first.success).toBe(false);
        expect(second.success).toBe(true);
        expect(mocks.sendTransaction).toHaveBeenCalledTimes(1);
    });

    it("does not sign or submit if simulation fails", async () => {
        mocks.simulateTransaction.mockResolvedValueOnce({ error: "Simulation failed" });
        const result = await claimVested(WALLET);
        expect(result.success).toBe(false);
        expect(mocks.signTransaction).not.toHaveBeenCalled();
        expect(mocks.sendTransaction).not.toHaveBeenCalled();
    });

    it("rejects a changed network passphrase before submission", async () => {
        mocks.signTransaction.mockImplementationOnce(async () => {
            mocks.passphrase = "Public Global Stellar Network ; September 2015";
            return { signedTxXdr: "signed-xdr" };
        });
        const result = await claimVested(WALLET);
        expect(result.success).toBe(false);
        expect(mocks.sendTransaction).not.toHaveBeenCalled();
    });
});
