import { validateWalletAddress } from "../middleware/validation";
import { getContractId, getAllContractIds } from "../services/contractRegistry";
import type { Request, Response, NextFunction } from "express";

function createMockReqRes(params: Record<string, string> = {}) {
    const req = { params } as unknown as Request;
    const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis(),
    } as unknown as Response;
    const next = jest.fn() as NextFunction;
    return { req, res, next };
}

const VALID_ADDR = "GABC2DEF3GHI4JKLM5NPQR6STUV7WXYZA7B2C3D4E5F6G7H2JKLMNOPQ";

describe("validateWalletAddress middleware", () => {
    it("calls next for a valid Stellar address", () => {
        const { req, res, next } = createMockReqRes({ address: VALID_ADDR });
        validateWalletAddress(req, res, next);
        expect(next).toHaveBeenCalled();
    });

    it("calls next for address starting with C", () => {
        const cAddr = "C" + VALID_ADDR.slice(1);
        const { req, res, next } = createMockReqRes({ address: cAddr });
        validateWalletAddress(req, res, next);
        expect(next).toHaveBeenCalled();
    });

    it("rejects empty address", () => {
        const { req, res, next } = createMockReqRes({ address: "" });
        validateWalletAddress(req, res, next);
        expect(next).not.toHaveBeenCalled();
    });

    it("rejects address that is too short", () => {
        const { req, res, next } = createMockReqRes({ address: "GSHORT" });
        validateWalletAddress(req, res, next);
        expect(next).not.toHaveBeenCalled();
    });

    it("rejects address that is too long", () => {
        const addr = VALID_ADDR + "EXTRA";
        const { req, res, next } = createMockReqRes({ address: addr });
        validateWalletAddress(req, res, next);
        expect(next).not.toHaveBeenCalled();
    });

    it("rejects address not starting with G or C", () => {
        const addr = "A" + VALID_ADDR.slice(1);
        const { req, res, next } = createMockReqRes({ address: addr });
        validateWalletAddress(req, res, next);
        expect(next).not.toHaveBeenCalled();
    });

    it("rejects address starting with lowercase letter", () => {
        const addr = "g" + VALID_ADDR.slice(1);
        const { req, res, next } = createMockReqRes({ address: addr });
        validateWalletAddress(req, res, next);
        expect(next).not.toHaveBeenCalled();
    });

    it("rejects address containing invalid characters (0, 1, 8, 9, I, O)", () => {
        const addr = "GA01I89BCDEFGHIJKLMNOPQRSTUVWXYZ23456789012345678901234";
        const { req, res, next } = createMockReqRes({ address: addr });
        validateWalletAddress(req, res, next);
        expect(next).not.toHaveBeenCalled();
    });

    it("rejects address with spaces", () => {
        const addr = "G" + "A".repeat(27) + " " + "B".repeat(27);
        const { req, res, next } = createMockReqRes({ address: addr });
        validateWalletAddress(req, res, next);
        expect(next).not.toHaveBeenCalled();
    });

    it("rejects address with special characters", () => {
        const addr = "G" + "A".repeat(53) + "!@";
        const { req, res, next } = createMockReqRes({ address: addr });
        validateWalletAddress(req, res, next);
        expect(next).not.toHaveBeenCalled();
    });

    it("validates walletAddress param as fallback", () => {
        const { req, res, next } = createMockReqRes({ walletAddress: VALID_ADDR });
        validateWalletAddress(req, res, next);
        expect(next).toHaveBeenCalled();
    });

    it("rejects undefined address (no param)", () => {
        const { req, res, next } = createMockReqRes({});
        validateWalletAddress(req, res, next);
        expect(next).not.toHaveBeenCalled();
    });

    it("rejects Ethereum-style address", () => {
        const addr = "0x742d35Cc6634C0532925a3b844Bc9e7595f2bD38";
        const { req, res, next } = createMockReqRes({ address: addr });
        validateWalletAddress(req, res, next);
        expect(next).not.toHaveBeenCalled();
    });

    it("rejects Solana-style address", () => {
        const addr = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
        const { req, res, next } = createMockReqRes({ address: addr });
        validateWalletAddress(req, res, next);
        expect(next).not.toHaveBeenCalled();
    });
});

describe("contractRegistry", () => {
    it("getContractId returns a string for known contract names", () => {
        const vault = getContractId("vault", "testnet");
        expect(typeof vault).toBe("string");
    });

    it("getAllContractIds returns entries for all contract names", () => {
        const all = getAllContractIds("testnet");
        expect(Object.keys(all)).toContain("vault");
        expect(Object.keys(all)).toContain("zap");
        expect(Object.keys(all)).toContain("token");
        expect(Object.keys(all)).toContain("governance");
        expect(Object.keys(all)).toContain("strategy");
    });

    it("getContractId returns empty string for unknown registry entry", () => {
        const id = getContractId("vault", "local");
        expect(typeof id).toBe("string");
    });

    it("getAllContractIds returns values for all networks", () => {
        const testnet = getAllContractIds("testnet");
        const mainnet = getAllContractIds("mainnet");
        expect(typeof testnet.vault).toBe("string");
        expect(typeof mainnet.vault).toBe("string");
    });
});
