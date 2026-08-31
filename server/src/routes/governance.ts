import { Router, Request, Response } from "express";
import rateLimit from "express-rate-limit";
import { createHash } from "crypto";
import {
  forecastGovernanceProposal,
  type GovernanceForecastInput,
  type ProposalType,
} from "../services/governanceForecastService";
import {
  validateProposalAttachments,
  type ProposalAttachmentInput,
} from "../../../shared/types/governanceProposalAttachment";

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

const MAX_ATTACHMENTS_PER_PROPOSAL = 20;

/**
 * POST /api/governance/proposals/attachments/validate
 *
 * Authoritative validation for proposal attachment metadata (issue #1033).
 * The client performs the same checks inline for UX, but this endpoint is
 * the source of truth — invalid or spoofed attachment metadata must never
 * be accepted just because the client-side form allowed it.
 *
 * For `transaction_payload` attachments the submitted `sha256` is recomputed
 * from the provided `xdr` and must match, so a client cannot claim a hash
 * for content it didn't actually submit.
 */
router.post("/proposals/attachments/validate", (req: Request, res: Response) => {
  const { attachments } = req.body as { attachments?: unknown };

  if (!Array.isArray(attachments) || attachments.length === 0) {
    res.status(400).json({
      valid: false,
      errors: [{ index: -1, field: "attachments", message: "attachments must be a non-empty array." }],
    });
    return;
  }

  if (attachments.length > MAX_ATTACHMENTS_PER_PROPOSAL) {
    res.status(400).json({
      valid: false,
      errors: [
        {
          index: -1,
          field: "attachments",
          message: `A proposal may have at most ${MAX_ATTACHMENTS_PER_PROPOSAL} attachments.`,
        },
      ],
    });
    return;
  }

  const candidates = attachments as Partial<ProposalAttachmentInput>[];
  const { valid, errors } = validateProposalAttachments(candidates);

  // Defense in depth: recompute the digest for transaction_payload
  // attachments from the XDR they claim to hash, independent of whatever
  // sha256 the client submitted.
  const hashErrors = candidates.flatMap((attachment, index) => {
    if (attachment.kind !== "transaction_payload" || !attachment.xdr) return [];
    const recomputed = createHash("sha256").update(attachment.xdr, "utf8").digest("hex");
    if (attachment.sha256 && recomputed !== attachment.sha256) {
      return [
        {
          index,
          kind: attachment.kind,
          field: "sha256",
          message: "sha256 does not match the SHA-256 digest of the provided xdr.",
        },
      ];
    }
    return [];
  });

  const allErrors = [...errors, ...hashErrors];
  if (allErrors.length > 0) {
    res.status(400).json({ valid: false, errors: allErrors });
    return;
  }

  res.json({
    valid: true,
    errors: [],
    attachments: candidates.map((attachment) => ({
      kind: attachment.kind,
      filename: attachment.filename,
      sha256: attachment.sha256,
    })),
  });
});

export default router;
