type Env = NodeJS.ProcessEnv;

const PLACEHOLDER_RELAYER_SECRET = "SAH2...";
const PLACEHOLDER_METRICS_TOKENS = ["change-this", "replace-with-a-real-token", "your-token", "placeholder"];
const PLACEHOLDER_AUDIT_SIGNING_KEYS = [
  "your-secure-signing-key-change-this-in-production",
  "change-this-in-production",
  "your-signing-key",
  "placeholder",
];

export interface EnvValidationResult {
  errors: string[];
  warnings: string[];
}

function hasValue(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function isPlaceholder(value: string | undefined, placeholders: string[]): boolean {
  if (!value) return false;
  const lower = value.trim().toLowerCase();
  return placeholders.some((p) => lower === p.toLowerCase() || lower.includes(p.toLowerCase()));
}

function isProduction(env: Env): boolean {
  return env.NODE_ENV === "production";
}

export function validateServerEnv(env: Env = process.env): EnvValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (env.PORT && Number.isNaN(Number(env.PORT))) {
    errors.push("PORT must be a number when provided.");
  }

  if (!hasValue(env.DATABASE_URL)) {
    const message =
      "DATABASE_URL is not set; Prisma-backed features and backend tests that require Postgres will fail.";
    if (isProduction(env)) errors.push(message);
    else warnings.push(message);
  }

  if (!hasValue(env.MONGODB_URI)) {
    const message = "MONGODB_URI is not set; database-backed routes and snapshot jobs will be unavailable.";
    if (isProduction(env)) errors.push(message);
    else warnings.push(message);
  }

  if (isProduction(env)) {
    if (!hasValue(env.METRICS_TOKEN)) {
      errors.push("METRICS_TOKEN is required in production to protect /api/metrics.");
    } else if (isPlaceholder(env.METRICS_TOKEN, PLACEHOLDER_METRICS_TOKENS)) {
      errors.push("METRICS_TOKEN must not be a placeholder value in production.");
    }
  }

  if (!hasValue(env.RELAYER_SECRET_KEY) || env.RELAYER_SECRET_KEY === PLACEHOLDER_RELAYER_SECRET) {
    const message = "RELAYER_SECRET_KEY must be set to a real Stellar secret before using /api/relayer/fee-bump.";
    if (isProduction(env)) errors.push(message);
    else warnings.push(message);
  }

  if (isProduction(env)) {
    if (!hasValue(env.AUDIT_SIGNING_KEY)) {
      errors.push("AUDIT_SIGNING_KEY is required in production for audit log integrity.");
    } else if (isPlaceholder(env.AUDIT_SIGNING_KEY, PLACEHOLDER_AUDIT_SIGNING_KEYS)) {
      errors.push("AUDIT_SIGNING_KEY must not be a placeholder value in production.");
    }
  }

  if (hasValue(env.DEX_ROUTER_CONTRACT_ID) !== hasValue(env.ZAP_QUOTE_SIM_SOURCE_ACCOUNT)) {
    errors.push("DEX_ROUTER_CONTRACT_ID and ZAP_QUOTE_SIM_SOURCE_ACCOUNT must be configured together.");
  }

  if (!hasValue(env.SOROBAN_RPC_URL)) {
    warnings.push("SOROBAN_RPC_URL is not set; the server will use the public testnet RPC fallback.");
  }

  if (!hasValue(env.STELLAR_HORIZON_URL)) {
    warnings.push("STELLAR_HORIZON_URL is not set; fee and network services will use default Horizon URLs.");
  }

  return { errors, warnings };
}

export function assertValidServerEnv(env: Env = process.env): EnvValidationResult {
  const result = validateServerEnv(env);

  for (const warning of result.warnings) {
    console.warn(`[env] ${warning}`);
  }

  if (result.errors.length > 0) {
    throw new Error(`Invalid server environment:\n- ${result.errors.join("\n- ")}`);
  }

  return result;
}
