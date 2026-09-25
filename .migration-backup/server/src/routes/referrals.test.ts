import request from "supertest";
import express from "express";
import referralsRouter from "./referrals";

const app = express();
app.use(express.json());
app.use("/api/referrals", referralsRouter);

describe("Referrals Route", () => {
  const validAddress = "GBB3K6V2MZYXZ2GBD2J3AQRWZ7RQRR2IHPJ44Q3N32S5X76T3L5IHTP3";
  const duplicateAddress = "GCY36TUZ2XVXZ2GBD2J3AQRWZ7RQRR2IHPJ44Q3N32S5X76T3L5IHTP4";
  const referrerAddress = "GDA2K6V2MZYXZ2GBD2J3AQRWZ7RQRR2IHPJ44Q3N32S5X76T3L5IHTP2";

  it("should validate and accept a valid referral code", async () => {
    const res = await request(app)
      .post("/api/referrals/submit")
      .send({ address: validAddress, referralCode: referrerAddress });
    
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("success", true);
  });

  it("should reject an invalid referral code format", async () => {
    const res = await request(app)
      .post("/api/referrals/submit")
      .send({ address: "SOMEADDRESS", referralCode: "INVALIDCODE" });
    
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Invalid referral code format");
  });

  it("should reject self-referral", async () => {
    const res = await request(app)
      .post("/api/referrals/submit")
      .send({ address: validAddress, referralCode: validAddress });
    
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Self-referral is not allowed.");
  });

  it("should reject duplicate referral attempts", async () => {
    // Apply first referral
    await request(app)
      .post("/api/referrals/submit")
      .send({ address: duplicateAddress, referralCode: referrerAddress });

    // Apply second referral
    const res = await request(app)
      .post("/api/referrals/submit")
      .send({ address: duplicateAddress, referralCode: "GBA2K6V2MZYXZ2GBD2J3AQRWZ7RQRR2IHPJ44Q3N32S5X76T3L5IH123" });
    
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("You have already applied a referral code.");
  });
});
