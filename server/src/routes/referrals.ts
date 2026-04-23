import { Router, Request, Response } from "express";

const router = Router();

// Mock database for referrals
// userAddress -> referrerAddress
const referralDb: Record<string, string> = {};

// Mock database for referral stats
// referrerAddress -> ReferralData
const statsDb: Record<string, { referredTvl: number; unclaimedRewards: number; totalReferrals: number }> = {};

router.get("/:address", (req: Request, res: Response) => {
  const { address } = req.params;
  const stats = statsDb[address] || {
    referredTvl: 0,
    unclaimedRewards: 0,
    totalReferrals: 0,
  };
  
  // Return stats and the link base
  res.json({
    ...stats,
    referralLink: `/?ref=${address}`,
  });
});

router.post("/claim", (req: Request, res: Response) => {
  const { address } = req.body;
  if (!address) {
    return res.status(400).json({ error: "Address is required" });
  }
  
  if (!statsDb[address] || statsDb[address].unclaimedRewards <= 0) {
    return res.status(400).json({ error: "No rewards to claim" });
  }
  
  // Reset rewards
  statsDb[address].unclaimedRewards = 0;
  res.json({ success: true });
});

router.post("/submit", (req: Request, res: Response) => {
  const { address, referralCode } = req.body;

  if (!address || !referralCode) {
    return res.status(400).json({ error: "Address and referral code are required" });
  }

  // 1. Basic format validation (already done on client, but good to have here)
  if (!/^[GC][A-Z2-7]{55}$/.test(referralCode)) {
    return res.status(400).json({ error: "Invalid referral code format. Must be a valid Stellar address." });
  }

  // 2. Self-referral prevention
  if (address === referralCode) {
    return res.status(400).json({ error: "Self-referral is not allowed." });
  }

  // 3. Duplicate handling: User already has a referrer
  if (referralDb[address]) {
    return res.status(400).json({ error: "You have already applied a referral code." });
  }

  // Save the referral
  referralDb[address] = referralCode;

  // Update referrer stats
  if (!statsDb[referralCode]) {
    statsDb[referralCode] = { referredTvl: 0, unclaimedRewards: 0, totalReferrals: 0 };
  }
  statsDb[referralCode].totalReferrals += 1;
  // Give them a mock reward
  statsDb[referralCode].unclaimedRewards += 5;

  return res.json({ success: true, message: "Referral code applied successfully!" });
});

export default router;
