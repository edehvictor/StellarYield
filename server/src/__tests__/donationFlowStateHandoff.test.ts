import request from "supertest";
import express from "express";
import donationsRouter, { _resetDonationsStore } from "../routes/donations";

const VALID_ADDRESS = "GABC2DEF3GHI4JKLM5NPQR6STUV7WXYZA7B2C3D4E5F6G7H2JKLMNOPQ";
const VALID_CHARITY = "GABC2DEF3GHI4JKLM5NPQR6STUV7WXYZA7B2C3D4E5F6G7H2JKLMNORST";

function createDonationApp() {
    const app = express();
    app.use(express.json());
    app.use("/api/donations", donationsRouter);
    return app;
}

beforeEach(() => {
    _resetDonationsStore();
});

describe("Donation flow state handoff", () => {
    it("preserves donation config across set and subsequent config read", async () => {
        const app = createDonationApp();

        await request(app).post("/api/donations/set").send({
            address: VALID_ADDRESS,
            bps: 250,
            charityAddress: VALID_CHARITY,
        });

        const configRes = await request(app).get(
            `/api/donations/config/${encodeURIComponent(VALID_ADDRESS)}`,
        );

        expect(configRes.status).toBe(200);
        expect(configRes.body.bps).toBe(250);
        expect(configRes.body.charityId).toBeNull();
    });

    it("overwrites previous config when re-setting for the same address", async () => {
        const app = createDonationApp();

        await request(app).post("/api/donations/set").send({
            address: VALID_ADDRESS,
            bps: 100,
            charityAddress: VALID_CHARITY,
        });

        await request(app).post("/api/donations/set").send({
            address: VALID_ADDRESS,
            bps: 500,
            charityAddress: VALID_CHARITY,
        });

        const configRes = await request(app).get(
            `/api/donations/config/${encodeURIComponent(VALID_ADDRESS)}`,
        );

        expect(configRes.status).toBe(200);
        expect(configRes.body.bps).toBe(500);
    });

    it("summary reflects latest config after overwrite", async () => {
        const app = createDonationApp();

        await request(app).post("/api/donations/set").send({
            address: VALID_ADDRESS,
            bps: 500,
            charityAddress: VALID_CHARITY,
        });

        let summaryRes = await request(app).get("/api/donations/summary");
        expect(summaryRes.body.participatingVaults).toBe(1);

        await request(app).post("/api/donations/set").send({
            address: VALID_ADDRESS,
            bps: 0,
            charityAddress: VALID_CHARITY,
        });

        summaryRes = await request(app).get("/api/donations/summary");
        expect(summaryRes.body.participatingVaults).toBe(0);
    });
});

describe("Donation impact preview survival across navigation", () => {
    it("summary metrics persist after repeated config reads", async () => {
        const app = createDonationApp();

        await request(app).post("/api/donations/set").send({
            address: VALID_ADDRESS,
            bps: 1000,
            charityAddress: VALID_CHARITY,
        });

        const summary1 = await request(app).get("/api/donations/summary");
        const impact1 = summary1.body.projectedMonthlyImpact;

        await request(app).get(
            `/api/donations/config/${encodeURIComponent(VALID_ADDRESS)}`,
        );
        await request(app).get("/api/donations/total");
        await request(app).get(
            `/api/donations/config/${encodeURIComponent(VALID_ADDRESS)}`,
        );

        const summary2 = await request(app).get("/api/donations/summary");
        expect(summary2.body.projectedMonthlyImpact).toBe(impact1);
        expect(summary2.body.participatingVaults).toBe(1);
    });

    it("total endpoint returns consistent value across multiple reads", async () => {
        const app = createDonationApp();

        const res1 = await request(app).get("/api/donations/total");
        const res2 = await request(app).get("/api/donations/total");

        expect(res1.body.totalDonated).toBe(res2.body.totalDonated);
    });

    it("summary correctly aggregates multiple donors", async () => {
        const app = createDonationApp();

        const users = [
            { address: "USER_A", bps: 500, charityAddress: VALID_CHARITY },
            { address: "USER_B", bps: 1000, charityAddress: VALID_CHARITY },
            { address: "USER_C", bps: 250, charityAddress: VALID_CHARITY },
        ];

        for (const user of users) {
            await request(app).post("/api/donations/set").send(user);
        }

        const summary = await request(app).get("/api/donations/summary");
        expect(summary.body.participatingVaults).toBe(3);
        expect(summary.body.projectedMonthlyImpact).toBeCloseTo(3 * 150.5, 1);
    });
});

describe("Failed confirmation and retry behavior", () => {
    it("rejects invalid bps then accepts valid retry", async () => {
        const app = createDonationApp();

        const failRes = await request(app).post("/api/donations/set").send({
            address: VALID_ADDRESS,
            bps: 99999,
            charityAddress: VALID_CHARITY,
        });
        expect(failRes.status).toBe(400);

        const retryRes = await request(app).post("/api/donations/set").send({
            address: VALID_ADDRESS,
            bps: 500,
            charityAddress: VALID_CHARITY,
        });
        expect(retryRes.status).toBe(200);
        expect(retryRes.body.success).toBe(true);
    });

    it("rejects missing address then accepts valid retry", async () => {
        const app = createDonationApp();

        const failRes = await request(app).post("/api/donations/set").send({
            bps: 500,
            charityAddress: VALID_CHARITY,
        });
        expect(failRes.status).toBe(400);

        const retryRes = await request(app).post("/api/donations/set").send({
            address: VALID_ADDRESS,
            bps: 500,
            charityAddress: VALID_CHARITY,
        });
        expect(retryRes.status).toBe(200);
    });

    it("rejects missing charityAddress then accepts valid retry", async () => {
        const app = createDonationApp();

        const failRes = await request(app).post("/api/donations/set").send({
            address: VALID_ADDRESS,
            bps: 500,
        });
        expect(failRes.status).toBe(400);

        const retryRes = await request(app).post("/api/donations/set").send({
            address: VALID_ADDRESS,
            bps: 500,
            charityAddress: VALID_CHARITY,
        });
        expect(retryRes.status).toBe(200);
    });

    it("failed POST does not corrupt existing config", async () => {
        const app = createDonationApp();

        await request(app).post("/api/donations/set").send({
            address: VALID_ADDRESS,
            bps: 300,
            charityAddress: VALID_CHARITY,
        });

        await request(app).post("/api/donations/set").send({
            address: VALID_ADDRESS,
            bps: -10,
            charityAddress: VALID_CHARITY,
        });

        const configRes = await request(app).get(
            `/api/donations/config/${encodeURIComponent(VALID_ADDRESS)}`,
        );
        expect(configRes.body.bps).toBe(300);
    });

    it("rejects non-numeric bps and accepts valid retry", async () => {
        const app = createDonationApp();

        const failRes = await request(app).post("/api/donations/set").send({
            address: VALID_ADDRESS,
            bps: "not-a-number",
            charityAddress: VALID_CHARITY,
        });
        expect(failRes.status).toBe(400);

        const retryRes = await request(app).post("/api/donations/set").send({
            address: VALID_ADDRESS,
            bps: 100,
            charityAddress: VALID_CHARITY,
        });
        expect(retryRes.status).toBe(200);
    });
});
