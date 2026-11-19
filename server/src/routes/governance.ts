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
import {
  computeSignerQuorumProgress,
  type SignerQuorumInput,
} from "../services/signerQuorumService";
import {
  computeGovernanceConfigFingerprint,
  validateGovernanceConfigSnapshot,
  verifyGovernanceConfigFingerprint,
  type GovernanceConfigSnapshot,
} from "../../../shared/types/governanceConfigSnapshot";
import { sendError } from "../utils/errorResponse";

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

type ConfigBinding =
  | {
      ok: true;
      snapshot: GovernanceConfigSnapshot;
      fingerprint: string;
    }
  | {
      ok: false;
      status: 400 | 409;
      error: string;
      message: string;
      details?: unknown;
      recoverable?: boolean;
    };

/**
 * Validates a caller's configuration snapshot/fingerprint without mutating any
 * governance state. A stale or malformed claim is rejected before the work
 * (forecast, quorum computation, proposal preparation) runs.
 */
function bindGovernanceConfig(
  snapshotInput: unknown,
  expectedFingerprint: unknown,
): ConfigBinding {
  const validation = validateGovernanceConfigSnapshot(snapshotInput);
  if (!validation.valid) {
    return {
      ok: false,
      status: 400,
      error: "INVALID_GOVERNANCE_CONFIG",
      message: "The governance configuration snapshot is invalid.",
      details: { issues: validation.issues },
    };
  }

  const verification = verifyGovernanceConfigFingerprint(
    validation.snapshot,
    expectedFingerprint,
  );
  if (!verification.valid) {
    return {
      ok: false,
      status: verification.status === "stale" ? 409 : 400,
      error: verification.code,
      message: verification.message,
      details: {
        expectedFingerprint: verification.expectedFingerprint,
        providedFingerprint: verification.actualFingerprint,
        driftReasons: verification.driftReasons,
      },
      recoverable: true,
    };
  }

  return {
    ok: true,
    snapshot: validation.snapshot,
    fingerprint: verification.expectedFingerprint,
  };
}

function sendConfigBindingError(res: Response, binding: Extract<ConfigBinding, { ok: false }>): void {
  sendError(
    res,
    binding.status,
    binding.error,
    binding.message,
    binding.details,
    undefined,
    binding.recoverable,
  );
}

/**
 * POST /api/governance/config-snapshot
 * Returns the canonical snapshot and immutable SHA-256 fingerprint for a
 * governance configuration. Read-only; clients use it to refresh stale work.
 */
router.post("/config-snapshot", (req: Request, res: Response) => {
  const validation = validateGovernanceConfigSnapshot(req.body);
  if (!validation.valid) {
    sendError(
      res,
      400,
      "INVALID_GOVERNANCE_CONFIG",
      "The governance configuration is invalid.",
      { issues: validation.issues },
    );
    return;
  }

  res.json(computeGovernanceConfigFingerprint(validation.snapshot));
});

/**
 * POST /api/governance/forecast
 * Returns an estimated impact forecast for a governance proposal.
 * Read-only — does not execute any on-chain operation.
 */
router.get("/forecast", (_req: Request, res: Response) => {
  res.json({ message: "Use POST /api/governance/forecast to submit forecast inputs." });
});

router.post("/forecast", forecastLimiter, (req: Request, res: Response) => {
  const {
    proposalType,
    parameters,
    baseline,
    configSnapshot,
    expectedConfigFingerprint,
  } = req.body as Partial<GovernanceForecastInput> & {
    configSnapshot?: unknown;
    expectedConfigFingerprint?: unknown;
  };

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

  const hasConfigClaim =
    configSnapshot !== undefined || expectedConfigFingerprint !== undefined;
  let binding: Extract<ConfigBinding, { ok: true }> | undefined;
  if (hasConfigClaim) {
    if (configSnapshot === undefined || expectedConfigFingerprint === undefined) {
      sendError(
        res,
        400,
        "INVALID_GOVERNANCE_CONFIG",
        "configSnapshot and expectedConfigFingerprint must be supplied together.",
      );
      return;
    }

    const bound = bindGovernanceConfig(configSnapshot, expectedConfigFingerprint);
    if (!bound.ok) {
      sendConfigBindingError(res, bound);
      return;
    }
    binding = bound;
  }

  const result = forecastGovernanceProposal({ proposalType, parameters, baseline });
  if (binding) {
    res.json({
      ...result,
      configSnapshot: binding.snapshot,
      configFingerprint: binding.fingerprint,
    });
    return;
  }

  res.json(result);
});

const MAX_ATTACHMENTS_PER_PROPOSAL = 20;

/**
 * POST /api/governance/quorum-progress
 * Body: { signers: string[], signatures: string[], threshold: number }
 *
 * Computes multi-sig signer quorum progress (signed/required/remaining,
 * progressPct, met, perSigner) without touching the chain. Read-only (#1310).
 */
router.post("/quorum-progress", (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Partial<SignerQuorumInput> & {
    contractId?: unknown;
    expectedConfigFingerprint?: unknown;
  };

  if (!Array.isArray(body.signers)) {
    sendError(res, 400, "INVALID_REQUEST", "signers must be an array of public keys.");
    return;
  }
  if (!Array.isArray(body.signatures)) {
    sendError(res, 400, "INVALID_REQUEST", "signatures must be an array of public keys.");
    return;
  }
  if (typeof body.threshold !== "number" || !Number.isFinite(body.threshold)) {
    sendError(res, 400, "INVALID_REQUEST", "threshold must be a number.");
    return;
  }

  const signers = body.signers.filter((s): s is string => typeof s === "string");
  const signatures = body.signatures.filter((s): s is string => typeof s === "string");
  const configSnapshot: GovernanceConfigSnapshot = {
    signers,
    threshold: body.threshold,
    contractId: typeof body.contractId === "string" ? body.contractId : "",
  };

  let binding: Extract<ConfigBinding, { ok: true }> | undefined;
  if (body.expectedConfigFingerprint !== undefined) {
    const bound = bindGovernanceConfig(
      configSnapshot,
      body.expectedConfigFingerprint,
    );
    if (!bound.ok) {
      sendConfigBindingError(res, bound);
      return;
    }
    binding = bound;
  }

  const progress = computeSignerQuorumProgress({
    signers,
    signatures,
    threshold: body.threshold,
  });
  res.json({
    ...progress,
    configFingerprint:
      binding?.fingerprint ??
      computeGovernanceConfigFingerprint(configSnapshot).fingerprint,
  });
});

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
