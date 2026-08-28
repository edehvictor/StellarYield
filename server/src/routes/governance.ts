import { Router, Request, Response } from "express";
import rateLimit from "express-rate-limit";
import {
  forecastGovernanceProposal,
  type GovernanceForecastInput,
  type ProposalType,
} from "../services/governanceForecastService";

const router = Router();

// #935 — forecast is compute-heavy; rate-limit to prevent burst abuse.
const forecastLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many governance forecast requests. Please try again later." },
});

const VALID_PROPOSAL_TYPES: ProposalType[] = [
  "fee_change",
  "allocation_limit",
  "strategy_param",
  "reward_change",
];

/**
 * POST /api/governance/forecast
 * Returns an estimated impact forecast for a governance proposal.
 * Read-only — does not execute any on-chain operation.
 */
router.get("/forecast", (_req: Request, res: Response) => {
  res.json({ message: "Use POST /api/governance/forecast to submit forecast inputs." });
});

router.post("/forecast", forecastLimiter, (req: Request, res: Response) => {
  const { proposalType, parameters, baseline } = req.body as Partial<GovernanceForecastInput>;

  if (!proposalType || !VALID_PROPOSAL_TYPES.includes(proposalType)) {
    res.status(400).json({
      error: `proposalType must be one of: ${VALID_PROPOSAL_TYPES.join(", ")}`,
    });
    return;
  }

  if (!parameters || typeof parameters !== "object") {
    res.status(400).json({ error: "parameters must be an object" });
    return;
  }

  if (
    !baseline ||
    typeof baseline.yieldPct !== "number" ||
    typeof baseline.exposurePct !== "number" ||
    typeof baseline.feeRatePct !== "number" ||
    typeof baseline.tvlUsd !== "number"
  ) {
    res.status(400).json({
      error: "baseline must include yieldPct, exposurePct, feeRatePct, and tvlUsd as numbers",
    });
    return;
  }

  const result = forecastGovernanceProposal({ proposalType, parameters, baseline });
  res.json(result);
});

export default router;
