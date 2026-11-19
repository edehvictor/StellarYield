/**
 * Client-side governance diagnostics mapping.
 *
 * Every failure in the governance UI is attributed to the stage the user was
 * actually in, so the rendered guidance can say *where* the flow stopped and
 * *what to do next* without exposing wallet addresses, XDR, or raw errors.
 *
 * Kept as pure functions so stage attribution can be regression tested without
 * mounting the transaction workflow.
 */
import {
  buildGovernanceFailureDiagnostics,
  type GovernanceDiagnostic,
} from "../../../../shared/types/governanceDiagnostic";

/** Failure while assembling or simulating an admin-action proposal. */
export function buildProposalBuildDiagnostics(): GovernanceDiagnostic[] {
  return buildGovernanceFailureDiagnostics("STAGE_UNAVAILABLE", {
    stage: "proposal-build",
  });
}

/** Failure while asking the wallet to co-sign a stored proposal. */
export function buildWalletSigningDiagnostics(): GovernanceDiagnostic[] {
  return buildGovernanceFailureDiagnostics("STAGE_UNAVAILABLE", {
    stage: "wallet-signing",
  });
}

/**
 * Failure while submitting or confirming an executable proposal.
 *
 * A failure during `polling` is ambiguous: the transaction may already have
 * reached the network, so retrying blindly could submit it twice. A failure
 * during `submitting` is safe to retry with the same signed XDR.
 */
export function buildExecutionDiagnostics(
  failedAt: "submitting" | "polling" | "idle",
): GovernanceDiagnostic[] {
  if (failedAt === "polling" || failedAt === "idle") {
    return buildGovernanceFailureDiagnostics("RETRY_UNSAFE", {
      stage: "confirmation",
      affectedStages: ["submission", "confirmation"],
    });
  }

  return buildGovernanceFailureDiagnostics("STAGE_UNAVAILABLE", {
    stage: "submission",
  });
}
