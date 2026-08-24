import request from "supertest";
import { createApp } from "../app";
import { _resetDonationsStore } from "../routes/donations";

beforeEach(() => {
    _resetDonationsStore();
});

describe("GET /api/donations/config/:address", () => {
    it("returns default config for unknown address", async () => {
        const res = await request(createApp()).get(
            "/api/donations/config/GDUNKNOWN",
        );
        expect(res.status).toBe(200);
        expect(res.body.bps).toBe(0);
        expect(res.body.charityId).toBeNull();
    });

    it("returns saved config after POST /set", async () => {
        const app = createApp();
        const address = "GADRESSSAVED";
        const charityAddress = "GDCHARITYADDRESS00000000000000000000";

        await request(app).post("/api/donations/set").send({
            address,
            bps: 500,
            charityAddress,
        });

        const res = await request(app).get(
            `/api/donations/config/${encodeURIComponent(address)}`,
        );
        expect(res.status).toBe(200);
        expect(res.body.bps).toBe(500);
    });
});

describe("POST /api/donations/set", () => {
    it("saves a valid donation config", async () => {
        const res = await request(createApp()).post("/api/donations/set").send({
            address: "GADRESS1",
            bps: 1000,
            charityAddress: "GDCHARITY000000000000000000000000001",
        });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
    });

    it("accepts bps = 0 (disable donation)", async () => {
        const res = await request(createApp()).post("/api/donations/set").send({
            address: "GADRESSDISABLE",
            bps: 0,
            charityAddress: "GDCHARITY000000000000000000000000001",
        });
        expect(res.status).toBe(200);
    });

    it("rejects missing address", async () => {
        const res = await request(createApp()).post("/api/donations/set").send({
            bps: 500,
            charityAddress: "GDCHARITY000000000000000000000000001",
        });
        expect(res.status).toBe(400);
    });

    it("rejects bps > 10000", async () => {
        const res = await request(createApp()).post("/api/donations/set").send({
            address: "GADRESS1",
            bps: 10001,
            charityAddress: "GDCHARITY000000000000000000000000001",
        });
        expect(res.status).toBe(400);
    });

    it("rejects negative bps", async () => {
        const res = await request(createApp()).post("/api/donations/set").send({
            address: "GADRESS1",
            bps: -1,
            charityAddress: "GDCHARITY000000000000000000000000001",
        });
        expect(res.status).toBe(400);
    });

    it("rejects missing charityAddress", async () => {
        const res = await request(createApp()).post("/api/donations/set").send({
            address: "GADRESS1",
            bps: 500,
        });
        expect(res.status).toBe(400);
    });
});

describe("GET /api/donations/total", () => {
    it("returns numeric totalDonated", async () => {
        const res = await request(createApp()).get("/api/donations/total");
        expect(res.status).toBe(200);
        expect(typeof res.body.totalDonated).toBe("number");
    });
});

describe("GET /api/donations/summary", () => {
    it("returns zero metrics when store is empty", async () => {
        const res = await request(createApp()).get("/api/donations/summary");
        expect(res.status).toBe(200);
        expect(res.body.totalDonated).toBe(0);
        expect(res.body.participatingVaults).toBe(0);
        expect(res.body.projectedMonthlyImpact).toBe(0);
    });

    it("reflects participating vaults after POST /set", async () => {
        const app = createApp();
        await request(app).post("/api/donations/set").send({
            address: "USER1",
            bps: 500,
            charityAddress: "CHARITY1",
        });
        await request(app).post("/api/donations/set").send({
            address: "USER2",
            bps: 1000,
            charityAddress: "CHARITY2",
        });
        await request(app).post("/api/donations/set").send({
            address: "USER3",
            bps: 0, // Should not count
            charityAddress: "CHARITY1",
        });

        const res = await request(app).get("/api/donations/summary");
        expect(res.status).toBe(200);
        expect(res.body.participatingVaults).toBe(2);
        expect(res.body.projectedMonthlyImpact).toBeGreaterThan(0);
    });
});

// ── POST /api/donations/preview ───────────────────────────────────────────────

const VALID_SENDER = "GABC1DEF2GHI3JKLMNOPQRSTUVWXYZ";
const VALID_RECIPIENT = "GBCD2EFG3HIJ4KLMNOPQRSTUVWXYZ12";

describe("POST /api/donations/preview — valid requests", () => {
    it("returns a structured preview for a valid donation", async () => {
        const res = await request(createApp())
            .post("/api/donations/preview")
            .send({
                senderAddress: VALID_SENDER,
                recipientAddress: VALID_RECIPIENT,
                grossAmountStroops: 10_000_000,
                bps: 500,
                memo: "Thank you",
            });

        expect(res.status).toBe(200);
        expect(res.body.isValid).toBe(true);
        expect(res.body.senderAddress).toBe(VALID_SENDER);
        expect(res.body.recipientAddress).toBe(VALID_RECIPIENT);
        expect(res.body.bps).toBe(500);
        expect(res.body.memo).toBe("Thank you");
    });

    it("returns correct fee breakdown proportions", async () => {
        const res = await request(createApp())
            .post("/api/donations/preview")
            .send({
                senderAddress: VALID_SENDER,
                recipientAddress: VALID_RECIPIENT,
                grossAmountStroops: 1_000_000,
                bps: 1000, // 10%
            });

        expect(res.status).toBe(200);
        const { breakdown } = res.body;
        expect(breakdown.grossAmountStroops).toBe(1_000_000);
        expect(breakdown.donationAmountStroops).toBe(100_000); // 10%
        expect(breakdown.netAmountStroops).toBe(900_000); // 90%
        expect(breakdown.effectiveRate).toBeCloseTo(0.1, 5);
    });

    it("handles bps = 0 (no donation — full amount retained)", async () => {
        const res = await request(createApp())
            .post("/api/donations/preview")
            .send({
                senderAddress: VALID_SENDER,
                recipientAddress: VALID_RECIPIENT,
                grossAmountStroops: 500_000,
                bps: 0,
            });

        expect(res.status).toBe(200);
        const { breakdown } = res.body;
        expect(breakdown.donationAmountStroops).toBe(0);
        expect(breakdown.netAmountStroops).toBe(500_000);
        expect(breakdown.effectiveRate).toBe(0);
    });

    it("handles bps = 10000 (full yield donated)", async () => {
        const res = await request(createApp())
            .post("/api/donations/preview")
            .send({
                senderAddress: VALID_SENDER,
                recipientAddress: VALID_RECIPIENT,
                grossAmountStroops: 2_000_000,
                bps: 10_000,
            });

        expect(res.status).toBe(200);
        const { breakdown } = res.body;
        expect(breakdown.donationAmountStroops).toBe(2_000_000);
        expect(breakdown.netAmountStroops).toBe(0);
        expect(breakdown.effectiveRate).toBe(1);
    });

    it("returns empty memo string when memo is omitted", async () => {
        const res = await request(createApp())
            .post("/api/donations/preview")
            .send({
                senderAddress: VALID_SENDER,
                recipientAddress: VALID_RECIPIENT,
                grossAmountStroops: 100_000,
                bps: 200,
            });

        expect(res.status).toBe(200);
        expect(res.body.memo).toBe("");
    });

    it("accepts memo exactly at the 28-byte limit", async () => {
        const memo28 = "A".repeat(28); // 28 ASCII bytes
        const res = await request(createApp())
            .post("/api/donations/preview")
            .send({
                senderAddress: VALID_SENDER,
                recipientAddress: VALID_RECIPIENT,
                grossAmountStroops: 100_000,
                bps: 200,
                memo: memo28,
            });

        expect(res.status).toBe(200);
        expect(res.body.memo).toBe(memo28);
    });

    it("validates bps = 1 (boundary lower non-zero donation)", async () => {
        const res = await request(createApp())
            .post("/api/donations/preview")
            .send({
                senderAddress: VALID_SENDER,
                recipientAddress: VALID_RECIPIENT,
                grossAmountStroops: 10_000,
                bps: 1,
            });

        expect(res.status).toBe(200);
        expect(res.body.breakdown.donationAmountStroops).toBe(1);
        expect(res.body.breakdown.netAmountStroops).toBe(9_999);
    });

    it("validates bps = 9999 (boundary just below maximum)", async () => {
        const res = await request(createApp())
            .post("/api/donations/preview")
            .send({
                senderAddress: VALID_SENDER,
                recipientAddress: VALID_RECIPIENT,
                grossAmountStroops: 10_000,
                bps: 9999,
            });

        expect(res.status).toBe(200);
        expect(res.body.breakdown.netAmountStroops).toBe(1);
    });
});

describe("POST /api/donations/preview — invalid recipient", () => {
    it("rejects missing recipientAddress", async () => {
        const res = await request(createApp())
            .post("/api/donations/preview")
            .send({
                senderAddress: VALID_SENDER,
                grossAmountStroops: 100_000,
                bps: 500,
            });

        expect(res.status).toBe(422);
        expect(res.body.validationErrors).toEqual(
            expect.arrayContaining([expect.stringContaining("recipientAddress")]),
        );
    });

    it("rejects empty recipientAddress string", async () => {
        const res = await request(createApp())
            .post("/api/donations/preview")
            .send({
                senderAddress: VALID_SENDER,
                recipientAddress: "",
                grossAmountStroops: 100_000,
                bps: 500,
            });

        expect(res.status).toBe(422);
        expect(res.body.validationErrors).toEqual(
            expect.arrayContaining([expect.stringContaining("recipientAddress")]),
        );
    });

    it("rejects recipientAddress that is too short", async () => {
        const res = await request(createApp())
            .post("/api/donations/preview")
            .send({
                senderAddress: VALID_SENDER,
                recipientAddress: "SHORT",
                grossAmountStroops: 100_000,
                bps: 500,
            });

        expect(res.status).toBe(422);
        expect(res.body.validationErrors).toEqual(
            expect.arrayContaining([expect.stringContaining("recipientAddress")]),
        );
    });
});

describe("POST /api/donations/preview — missing memo handling", () => {
    it("treats null memo same as omitted memo (empty string)", async () => {
        const res = await request(createApp())
            .post("/api/donations/preview")
            .send({
                senderAddress: VALID_SENDER,
                recipientAddress: VALID_RECIPIENT,
                grossAmountStroops: 100_000,
                bps: 200,
                memo: null,
            });

        expect(res.status).toBe(200);
        expect(res.body.memo).toBe("");
    });

    it("rejects memo exceeding 28 bytes", async () => {
        const longMemo = "A".repeat(29); // 29 ASCII bytes — over limit
        const res = await request(createApp())
            .post("/api/donations/preview")
            .send({
                senderAddress: VALID_SENDER,
                recipientAddress: VALID_RECIPIENT,
                grossAmountStroops: 100_000,
                bps: 200,
                memo: longMemo,
            });

        expect(res.status).toBe(422);
        expect(res.body.validationErrors).toEqual(
            expect.arrayContaining([expect.stringContaining("memo")]),
        );
    });

    it("rejects multi-byte UTF-8 memo that overflows the 28-byte limit", async () => {
        // Each '€' is 3 bytes in UTF-8; 10 × 3 = 30 bytes > 28
        const multiByteOverflow = "€".repeat(10);
        const res = await request(createApp())
            .post("/api/donations/preview")
            .send({
                senderAddress: VALID_SENDER,
                recipientAddress: VALID_RECIPIENT,
                grossAmountStroops: 100_000,
                bps: 200,
                memo: multiByteOverflow,
            });

        expect(res.status).toBe(422);
        expect(res.body.validationErrors).toEqual(
            expect.arrayContaining([expect.stringContaining("memo")]),
        );
    });
});

describe("POST /api/donations/preview — fee boundary cases", () => {
    it("rejects bps greater than 10000", async () => {
        const res = await request(createApp())
            .post("/api/donations/preview")
            .send({
                senderAddress: VALID_SENDER,
                recipientAddress: VALID_RECIPIENT,
                grossAmountStroops: 100_000,
                bps: 10_001,
            });

        expect(res.status).toBe(422);
        expect(res.body.validationErrors).toEqual(
            expect.arrayContaining([expect.stringContaining("bps")]),
        );
    });

    it("rejects negative bps", async () => {
        const res = await request(createApp())
            .post("/api/donations/preview")
            .send({
                senderAddress: VALID_SENDER,
                recipientAddress: VALID_RECIPIENT,
                grossAmountStroops: 100_000,
                bps: -1,
            });

        expect(res.status).toBe(422);
        expect(res.body.validationErrors).toEqual(
            expect.arrayContaining([expect.stringContaining("bps")]),
        );
    });

    it("rejects non-integer bps (float)", async () => {
        const res = await request(createApp())
            .post("/api/donations/preview")
            .send({
                senderAddress: VALID_SENDER,
                recipientAddress: VALID_RECIPIENT,
                grossAmountStroops: 100_000,
                bps: 500.5,
            });

        expect(res.status).toBe(422);
        expect(res.body.validationErrors).toEqual(
            expect.arrayContaining([expect.stringContaining("bps")]),
        );
    });

    it("rejects zero grossAmountStroops", async () => {
        const res = await request(createApp())
            .post("/api/donations/preview")
            .send({
                senderAddress: VALID_SENDER,
                recipientAddress: VALID_RECIPIENT,
                grossAmountStroops: 0,
                bps: 500,
            });

        expect(res.status).toBe(422);
        expect(res.body.validationErrors).toEqual(
            expect.arrayContaining([
                expect.stringContaining("grossAmountStroops"),
            ]),
        );
    });

    it("rejects negative grossAmountStroops", async () => {
        const res = await request(createApp())
            .post("/api/donations/preview")
            .send({
                senderAddress: VALID_SENDER,
                recipientAddress: VALID_RECIPIENT,
                grossAmountStroops: -1000,
                bps: 500,
            });

        expect(res.status).toBe(422);
        expect(res.body.validationErrors).toEqual(
            expect.arrayContaining([
                expect.stringContaining("grossAmountStroops"),
            ]),
        );
    });

    it("rejects non-integer grossAmountStroops", async () => {
        const res = await request(createApp())
            .post("/api/donations/preview")
            .send({
                senderAddress: VALID_SENDER,
                recipientAddress: VALID_RECIPIENT,
                grossAmountStroops: 1000.5,
                bps: 500,
            });

        expect(res.status).toBe(422);
        expect(res.body.validationErrors).toEqual(
            expect.arrayContaining([
                expect.stringContaining("grossAmountStroops"),
            ]),
        );
    });

    it("accumulates multiple validation errors in one response", async () => {
        const res = await request(createApp())
            .post("/api/donations/preview")
            .send({
                // Missing senderAddress, invalid bps and grossAmount
                recipientAddress: VALID_RECIPIENT,
                grossAmountStroops: -5,
                bps: 99999,
            });

        expect(res.status).toBe(422);
        expect(res.body.validationErrors.length).toBeGreaterThanOrEqual(3);
    });
});
