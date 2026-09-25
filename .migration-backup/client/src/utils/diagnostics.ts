/**
 * Diagnostics utility for route-level error reporting.
 *
 * Classifies failures into typed categories so monitoring systems and console
 * output carry actionable context (route name + failure type).
 */

/** High-level failure categories that a route boundary can emit. */
export type RouteFailureType =
  | "chunk_load_error" // dynamic import / code-splitting chunk failed to fetch
  | "render_error"     // component threw during React render
  | "unknown";         // anything that doesn't match the above

/**
 * Infer the failure type from the raw error thrown by a lazy-loaded route.
 *
 * Vite and webpack both surface failed chunks as errors whose name or message
 * contains "ChunkLoadError" or "Loading chunk" / "Loading CSS chunk".
 */
export function classifyRouteFailure(error: unknown): RouteFailureType {
  if (!(error instanceof Error)) return "unknown";

  const name = error.name ?? "";
  const msg = error.message ?? "";

  if (
    name === "ChunkLoadError" ||
    /loading chunk/i.test(msg) ||
    /loading css chunk/i.test(msg) ||
    /failed to fetch dynamically imported module/i.test(msg) ||
    /dynamically imported module/i.test(msg)
  ) {
    return "chunk_load_error";
  }

  return "render_error";
}

export interface RouteErrorContext {
  routeName: string;
  failureType: RouteFailureType;
  error: Error;
}

/**
 * Log a route-level failure through the diagnostics channel.
 *
 * Emits a structured console.error so log-aggregation tools (Sentry,
 * Datadog, etc.) can index `routeName` and `failureType` as structured
 * fields, while the raw stack is still present.
 */
export function logRouteFailure({ routeName, failureType, error }: RouteErrorContext): void {
  console.error("[diagnostics] route failure", {
    routeName,
    failureType,
    message: error.message,
    stack: error.stack,
  });
}
