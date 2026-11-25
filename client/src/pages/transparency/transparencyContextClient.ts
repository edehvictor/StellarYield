/**
 * Client side of the transparency network, ledger and version binding (#1916).
 *
 * Every summary read names the network this build is configured for, the
 * schema version it understands and the last ledger it has shown. A response
 * from another network, an incompatible schema or an older ledger never
 * replaces the snapshot on screen.
 */

import { getNetworkPassphrase, type EnvLike } from "../../lib/networkEnv";
import {
  TRANSPARENCY_SCHEMA_VERSION,
  TransparencyContextError,
  decideTransparencySnapshot,
  normalizeTransparencyNetwork,
  parseTransparencyContext,
  type TransparencyContext,
  type TransparencyContextErrorCode,
  type TransparencyNetwork,
} from "../../../../shared/types/transparencyContext";
import { validateTransparencySummaryPayload, type TransparencySummaryPayload } from "./transparencyServiceHealth";

export { TransparencyContextError, TRANSPARENCY_SCHEMA_VERSION };
export type { TransparencyContext, TransparencyNetwork };

/** The network this client build signs for, or null if it is not recognized. */
export function getExpectedTransparencyNetwork(env?: EnvLike): TransparencyNetwork | null {
  return normalizeTransparencyNetwork(env ? getNetworkPassphrase(env) : getNetworkPassphrase());
}

export interface SummaryRequestContext {
  network: TransparencyNetwork | null;
  /** Context of the snapshot currently shown, if any. */
  current: TransparencyContext | null;
}

/** Summary URL carrying the caller's network, schema version and last ledger. */
export function buildTransparencySummaryUrl(apiBase: string, request: SummaryRequestContext): string {
  const params = new URLSearchParams();
  if (request.network) params.set("network", request.network);
  params.set("version", TRANSPARENCY_SCHEMA_VERSION);
  if (request.current) params.set("minLedger", String(request.current.ledger));
  return `${apiBase}/api/transparency/summary?${params.toString()}`;
}

export type SummaryReadResult =
  | {
      kind: "accept";
      data: TransparencySummaryPayload;
      /** Null when an older server sent no context; the snapshot is then unbound. */
      context: TransparencyContext | null;
    }
  | { kind: "keep-current"; error: TransparencyContextError };

const CONTEXT_CODES: ReadonlySet<string> = new Set<TransparencyContextErrorCode>([
  "INVALID_TRANSPARENCY_CONTEXT",
  "TRANSPARENCY_NETWORK_MISMATCH",
  "TRANSPARENCY_VERSION_MISMATCH",
  "TRANSPARENCY_LEDGER_BEHIND",
  "TRANSPARENCY_LEDGER_REGRESSION",
]);

/**
 * Interpret a summary response against the snapshot already shown.
 * Throws for transport and payload failures (the caller keeps its snapshot);
 * returns `keep-current` when the server or the response is bound to a
 * different network, version or an older ledger.
 */
export async function readTransparencySummaryResponse(
  res: Pick<Response, "ok" | "status" | "json">,
  request: SummaryRequestContext,
): Promise<SummaryReadResult> {
  if (res.status === 409 || res.status === 400) {
    const body = (await res.json().catch(() => ({}))) as {
      code?: string;
      error?: string;
      retryable?: boolean;
    };
    if (body.code && CONTEXT_CODES.has(body.code)) {
      return {
        kind: "keep-current",
        error: new TransparencyContextError(
          body.code as TransparencyContextErrorCode,
          body.error ?? "Transparency status does not match this client's network context.",
          body.retryable === true,
        ),
      };
    }
  }
  if (!res.ok) {
    throw new Error(`Server returned ${res.status}`);
  }

  const raw: unknown = await res.json();
  const data = validateTransparencySummaryPayload(raw);
  const rawContext = (raw as { context?: unknown }).context;
  if (rawContext === undefined) {
    return { kind: "accept", data, context: null };
  }

  let context: TransparencyContext;
  try {
    context = parseTransparencyContext(rawContext);
  } catch (err) {
    if (err instanceof TransparencyContextError) return { kind: "keep-current", error: err };
    throw err;
  }

  const decision = decideTransparencySnapshot(request.current, context, {
    network: request.network ?? undefined,
    version: TRANSPARENCY_SCHEMA_VERSION,
  });
  if (decision.action === "keep-current") {
    return { kind: "keep-current", error: decision.error };
  }
  return { kind: "accept", data, context };
}

/** Human-readable label for a snapshot's context, e.g. "testnet · ledger 512". */
export function formatTransparencyContext(context: TransparencyContext): string {
  return `${context.network} · ledger ${context.ledger.toLocaleString("en-US")}`;
}
