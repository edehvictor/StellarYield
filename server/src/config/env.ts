type Env = NodeJS.ProcessEnv;

const PLACEHOLDER_RELAYER_SECRET = "SAH2...";

export interface EnvValidationResult {
  errors: string[];
  warnings: string[];
}

function hasValue(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
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

  if (!hasValue(env.MONGODB_URI)) {
    const message = "MONGODB_URI is not set; database-backed routes and snapshot jobs will be unavailable.";
    if (isProduction(env)) errors.push(message);
    else warnings.push(message);
  }

  if (isProduction(env) && !hasValue(env.METRICS_TOKEN)) {
    errors.push("METRICS_TOKEN is required in production to protect /api/metrics.");
  }

  if (!hasValue(env.RELAYER_SECRET_KEY) || env.RELAYER_SECRET_KEY === PLACEHOLDER_RELAYER_SECRET) {
    const message = "RELAYER_SECRET_KEY must be set to a real Stellar secret before using /api/relayer/fee-bump.";
    if (isProduction(env)) errors.push(message);
    else warnings.push(message);
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
