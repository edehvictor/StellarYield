/**
 * Optional preflight check for production metrics protection.
 *
 * - Exits non-zero only when NODE_ENV=production and METRICS_TOKEN is missing/blank.
 * - Never logs the token value.
 */

function hasValue(value) {
  return typeof value === "string" && value.trim().length > 0;
}

const nodeEnv = process.env.NODE_ENV;
const token = process.env.METRICS_TOKEN;

if (nodeEnv === "production" && !hasValue(token)) {
  console.error(
    "METRICS_TOKEN is required when NODE_ENV=production (protects /api/metrics and /metrics).",
  );
  process.exit(1);
}

process.stdout.write("metrics token check: ok\n");

