/**
 * Best-effort telemetry for rejected wallet signatures (#1363).
 *
 * Recovery must work offline, so this call never blocks or throws: the local
 * typed classifier in `shared/types/walletSignatureRejection.ts` is the source
 * of truth for what the user sees. The server records the event (without raw
 * provider text) and returns the same stable vocabulary.
 */

import { apiFetch, apiUrl } from "../../lib/api";
import type {
  WalletSignatureRejection,
  WalletSignatureRejectionCode,
} from "../../../../shared/types/walletSignatureRejection";

export interface SignatureRejectionReport {
  /** Action the user was attempting, e.g. `portfolio_deposit`. */
  action: string;
  rejection: WalletSignatureRejection;
  walletAddress?: string | null;
  /** Number of vault deposits that finished before the rejection, if any. */
  completedSteps?: number;
  totalSteps?: number;
}

export interface SignatureRejectionTelemetryResponse {
  code: WalletSignatureRejectionCode;
  retryable: boolean;
  remainingAttempts: number;
}

/**
 * POST /api/wallet/signature-rejections
 *
 * Returns the server acknowledgement, or `null` when telemetry is unavailable.
 * Never throws — a failed report must not replace the recovery UI.
 */
export async function reportSignatureRejection(
  report: SignatureRejectionReport,
): Promise<SignatureRejectionTelemetryResponse | null> {
  try {
    const response = await apiFetch(apiUrl("/api/wallet/signature-rejections"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        walletAddress: report.walletAddress ?? undefined,
        provider: report.rejection.provider,
        action: report.action,
        code: report.rejection.code,
        attempt: report.rejection.attempt,
        maxAttempts: report.rejection.maxAttempts,
        completedSteps: report.completedSteps,
        totalSteps: report.totalSteps,
      }),
    });

    if (!response.ok) return null;

    const payload = (await response.json()) as Partial<SignatureRejectionTelemetryResponse>;
    if (typeof payload.code !== "string") return null;

    return {
      code: payload.code,
      retryable: Boolean(payload.retryable),
      remainingAttempts:
        typeof payload.remainingAttempts === "number"
          ? payload.remainingAttempts
          : 0,
    };
  } catch {
    return null;
  }
}
