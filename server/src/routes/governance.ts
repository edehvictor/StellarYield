import { Router, Request, Response } from "express";
import {
  forecastGovernanceProposal,
  type GovernanceForecastInput,
  type ProposalType,
} from "../services/governanceForecastService";

const router = Router();

const VALID_PROPOSAL_TYPES: ProposalType[] = [
  "fee_change",
  "allocation_limit",
  "strategy_param",
];

/**
 * POST /api/governance/forecast
 * Returns an estimated impact forecast for a governance proposal.
 * Read-only — does not execute any on-chain operation.
 */
router.post("/forecast", (req: Request, res: Response) => {
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
