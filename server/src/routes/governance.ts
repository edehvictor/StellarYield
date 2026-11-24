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
  buildGovernanceFailureDiagnostics,
  type GovernanceDiagnostic,
  type GovernanceDiagnosticCode,
  type GovernanceStage,
} from "../../../shared/types/governanceDiagnostic";

const router = Router();

interface GovernanceFailureOptions {
  /** Names of invalid request fields. Never contains submitted values. */
  fields?: string[];
  affectedStages?: GovernanceStage[];
  retryable?: boolean;
  preserveState?: boolean;
  /** Additional non-sensitive response fields (for example `valid: false`). */
  extra?: Record<string, unknown>;
}

/**
 * Send a privacy-safe governance failure.
 *
 * The response names the failed stage and a remediation path using fixed
 * templates from `shared/types/governanceDiagnostic.ts`. Raw error text, request
 * bodies, XDR, wallet addresses, and stack traces are never echoed. Every
 * failure also states that existing proposal, signature, and balance state was
 * preserved, because none of these routes writes state before validating.
 */
function sendGovernanceFailure(
  res: Response,
  statusCode: number,
  code: GovernanceDiagnosticCode,
  stage: GovernanceStage,
  options: GovernanceFailureOptions = {},
): void {
  const diagnostics: GovernanceDiagnostic[] = buildGovernanceFailureDiagnostics(
    code,
    {
      stage,
      affectedStages: options.affectedStages,
      retryable: options.retryable,
      preserveState: options.preserveState,
    },
  );

  res.status(statusCode).json({
    error: code,
    message: diagnostics[0].summary,
    stage,
    retryable: diagnostics[0].retryable,
    diagnostics,
    ...(options.fields && options.fields.length > 0
      ? { fields: options.fields }
      : {}),
    ...(options.extra ?? {}),
  });
}

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
  const body =
    req.body && typeof req.body === "object" && !Array.isArray(req.body)
      ? (req.body as Partial<GovernanceForecastInput>)
      : {};
  const { proposalType, parameters, baseline } = body;

  const invalidFields: string[] = [];
  if (!proposalType || !VALID_PROPOSAL_TYPES.includes(proposalType)) {
    invalidFields.push("proposalType");
  }
  if (
    !parameters ||
    typeof parameters !== "object" ||
    Array.isArray(parameters)
  ) {
    invalidFields.push("parameters");
  }
  if (
    !baseline ||
    typeof baseline !== "object" ||
    !Number.isFinite(baseline.yieldPct) ||
    !Number.isFinite(baseline.exposurePct) ||
    !Number.isFinite(baseline.feeRatePct) ||
    !Number.isFinite(baseline.tvlUsd)
  ) {
    invalidFields.push("baseline");
  }

  if (
    invalidFields.length > 0 ||
    !proposalType ||
    !parameters ||
    !baseline
  ) {
    sendGovernanceFailure(res, 400, "VALIDATION_FAILED", "request-validation", {
      fields: invalidFields,
    });
    return;
  }

  try {
    const result = forecastGovernanceProposal({
      proposalType,
      parameters: parameters as Record<string, number>,
      baseline,
    });
    res.json(result);
  } catch {
    // Never echo the thrown error: it may contain input values or stack frames.
    sendGovernanceFailure(res, 500, "STAGE_UNAVAILABLE", "forecast");
  }
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
  const body =
    req.body && typeof req.body === "object" && !Array.isArray(req.body)
      ? (req.body as Partial<SignerQuorumInput>)
      : {};

  const invalidFields: string[] = [];
  if (!Array.isArray(body.signers)) invalidFields.push("signers");
  if (!Array.isArray(body.signatures)) invalidFields.push("signatures");
  if (typeof body.threshold !== "number" || !Number.isFinite(body.threshold)) {
    invalidFields.push("threshold");
  }

  if (
    invalidFields.length > 0 ||
    !Array.isArray(body.signers) ||
    !Array.isArray(body.signatures) ||
    typeof body.threshold !== "number" ||
    !Number.isFinite(body.threshold)
  ) {
    sendGovernanceFailure(res, 400, "VALIDATION_FAILED", "request-validation", {
      fields: invalidFields,
    });
    return;
  }

  try {
    const progress = computeSignerQuorumProgress({
      signers: body.signers.filter((s): s is string => typeof s === "string"),
      signatures: body.signatures.filter((s): s is string => typeof s === "string"),
      threshold: body.threshold,
    });
    res.json(progress);
  } catch {
    sendGovernanceFailure(res, 500, "STAGE_UNAVAILABLE", "quorum");
  }
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
  const { attachments } = (req.body ?? {}) as { attachments?: unknown };

  if (!Array.isArray(attachments) || attachments.length === 0) {
    sendGovernanceFailure(res, 400, "CONTEXT_INSUFFICIENT", "attachments", {
      fields: ["attachments"],
      extra: {
        valid: false,
        errors: [
          {
            index: -1,
            field: "attachments",
            message: "attachments must be a non-empty array.",
          },
        ],
      },
    });
    return;
  }

  if (attachments.length > MAX_ATTACHMENTS_PER_PROPOSAL) {
    sendGovernanceFailure(res, 400, "VALIDATION_FAILED", "attachments", {
      fields: ["attachments"],
      extra: {
        valid: false,
        errors: [
          {
            index: -1,
            field: "attachments",
            message: `A proposal may have at most ${MAX_ATTACHMENTS_PER_PROPOSAL} attachments.`,
          },
        ],
      },
    });
    return;
  }

  try {
    const candidates = attachments as Partial<ProposalAttachmentInput>[];
    const { valid, errors } = validateProposalAttachments(candidates);

    // Defense in depth: recompute the digest for transaction_payload
    // attachments from the XDR they claim to hash, independent of whatever
    // sha256 the client submitted. Malformed XDR is reported as a field error
    // rather than allowed to throw an opaque 500.
    const hashErrors = candidates.flatMap((attachment, index) => {
      if (attachment.kind !== "transaction_payload") return [];
      if (attachment.xdr === undefined || attachment.xdr === null) return [];
      if (typeof attachment.xdr !== "string") {
        return [
          {
            index,
            kind: attachment.kind,
            field: "xdr",
            message: "xdr must be a string.",
          },
        ];
      }
      if (!attachment.xdr) return [];

      const recomputed = createHash("sha256")
        .update(attachment.xdr, "utf8")
        .digest("hex");
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
      sendGovernanceFailure(res, 400, "VALIDATION_FAILED", "attachments", {
        fields: [...new Set(allErrors.map((error) => error.field))],
        extra: { valid: false, errors: allErrors },
      });
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
  } catch {
    // Validation is read-only; a failure here must not be reported as a
    // successful or partially-applied proposal submission.
    sendGovernanceFailure(res, 500, "STAGE_UNAVAILABLE", "attachments", {
      extra: { valid: false, errors: [] },
    });
  }
});

export default router;
