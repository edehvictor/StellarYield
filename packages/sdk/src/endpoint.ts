import type { ApiRetryConfig, ApiCacheStore } from "./types";
import {
  SdkDiagnostic,
  SdkDiagnosticCode,
  SdkStage,
  buildSdkFailureDiagnostics,
  areDiagnosticsPrivacySafe,
} from "./diagnostics";
import {
  EndpointConfigVersionConflictError,
  SdkEndpointError,
  isEndpointConfigVersionConflictError,
} from "./errors";

/**
 * Diagnostic context optionally provided when configuring an endpoint or
 * issuing requests.
 */
export interface EndpointDiagnosticContext {
  /** Optional correlation or request ID for distributed tracing. */
  correlationId?: string;
  /** Environment or client tier identifier (e.g. 'production', 'testnet'). */
  environment?: string;
  /** Whether state preservation should be explicitly attached to diagnostics. Defaults to true. */
  preserveState?: boolean;
}

/**
 * Enhanced configuration for SDK endpoints.
 */
export interface SdkEndpointConfig extends ApiRetryConfig {
  /** Primary base URL for API or RPC requests (e.g. 'https://api.stellaryield.com'). */
  baseUrl: string;
  /** Optional backup/fallback URLs to use when the primary endpoint is degraded or unavailable. */
  fallbackUrls?: string[];
  /** Optional diagnostic context. */
  diagnosticContext?: EndpointDiagnosticContext;
  /** Cache store for offline fallback. */
  cacheStore?: ApiCacheStore;
}

export interface EndpointValidationResult {
  valid: boolean;
  errors: string[];
  diagnostics: SdkDiagnostic[];
}

/**
 * Validates a single endpoint URL.
 * Rejects empty strings, non-http/https protocols, malformed URLs, and URLs with embedded user credentials.
 */
export function validateEndpointUrl(url: unknown): { valid: boolean; error?: string } {
  if (typeof url !== "string" || url.trim() === "") {
    return { valid: false, error: "Endpoint URL must be a non-empty string." };
  }

  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { valid: false, error: "Endpoint URL protocol must be 'http:' or 'https:'." };
    }
    if (parsed.username || parsed.password) {
      return { valid: false, error: "Endpoint URL must not contain embedded user credentials." };
    }
    return { valid: true };
  } catch {
    return { valid: false, error: "Endpoint URL is not a valid absolute URL." };
  }
}

/**
 * Normalizes an endpoint URL (trims trailing slashes).
 */
export function normalizeEndpointUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

/**
 * Validates an SDK endpoint configuration object.
 * Returns privacy-safe diagnostics when validation fails, identifying the
 * `endpoint-configuration` stage and confirming that existing state and balances
 * were preserved.
 */
export function validateEndpointConfig(config: unknown): EndpointValidationResult {
  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    const diagnostics = buildSdkFailureDiagnostics("VALIDATION_FAILED", {
      stage: "endpoint-configuration",
      summary: "Endpoint configuration must be a valid non-null object.",
      remediation: "Provide a valid configuration object with a valid 'baseUrl'; prior state was preserved.",
    });
    return {
      valid: false,
      errors: ["Configuration must be a non-null object."],
      diagnostics,
    };
  }

  const errors: string[] = [];
  const cfg = config as Partial<SdkEndpointConfig>;

  const baseResult = validateEndpointUrl(cfg.baseUrl);
  if (!baseResult.valid) {
    errors.push(`baseUrl: ${baseResult.error}`);
  }

  if (cfg.fallbackUrls !== undefined) {
    if (!Array.isArray(cfg.fallbackUrls)) {
      errors.push("fallbackUrls must be an array of URL strings.");
    } else {
      for (let i = 0; i < cfg.fallbackUrls.length; i++) {
        const fallbackRes = validateEndpointUrl(cfg.fallbackUrls[i]);
        if (!fallbackRes.valid) {
          errors.push(`fallbackUrls[${i}]: ${fallbackRes.error}`);
        }
      }
    }
  }

  if (
    cfg.timeoutMs !== undefined &&
    (typeof cfg.timeoutMs !== "number" || cfg.timeoutMs <= 0 || !Number.isFinite(cfg.timeoutMs))
  ) {
    errors.push("timeoutMs must be a positive finite number.");
  }

  if (
    cfg.maxRetries !== undefined &&
    (typeof cfg.maxRetries !== "number" || cfg.maxRetries < 0 || !Number.isInteger(cfg.maxRetries))
  ) {
    errors.push("maxRetries must be a non-negative integer.");
  }

  if (
    cfg.retryDelayMs !== undefined &&
    (typeof cfg.retryDelayMs !== "number" || cfg.retryDelayMs < 0 || !Number.isFinite(cfg.retryDelayMs))
  ) {
    errors.push("retryDelayMs must be a non-negative number.");
  }

  if (errors.length > 0) {
    const diagnostics = buildSdkFailureDiagnostics("VALIDATION_FAILED", {
      stage: "endpoint-configuration",
      summary: "Endpoint configuration rejected during parameter validation.",
      remediation: "Correct the invalid endpoint parameters; existing state and balances are unchanged.",
    });
    return { valid: false, errors, diagnostics };
  }

  return { valid: true, errors: [], diagnostics: [] };
}

export interface EndpointConfigSnapshot<TConfig extends object> {
  readonly config: TConfig;
  readonly version: number;
}

export interface EndpointConfigUpdateOptions {
  readonly expectedVersion?: number;
}

export type EndpointConfigChange<TConfig extends object> =
  | Partial<TConfig>
  | ((
      current: Readonly<TConfig>,
      version: number
    ) => Partial<TConfig> | Promise<Partial<TConfig>>);

export interface EndpointConfigRetryEvent {
  readonly expectedVersion: number;
  readonly currentVersion: number;
  readonly attempt: number;
}

export interface EndpointConfigUpdateResult<TConfig extends object>
  extends EndpointConfigSnapshot<TConfig> {
  readonly attempts: number;
  readonly retries: number;
}

export interface EndpointConfigStateOptions<TConfig extends object> {
  validate: (config: TConfig) => EndpointValidationResult;
  normalize?: (config: TConfig) => TConfig;
  label?: string;
}

export interface SafeEndpointConfigUpdateOptions<TConfig extends object>
  extends EndpointConfigUpdateOptions {
  change: EndpointConfigChange<TConfig>;
  maxAttempts?: number;
  onRetry?: (event: EndpointConfigRetryEvent) => void;
}

function cloneEndpointValue<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => cloneEndpointValue(item)) as unknown as T;
  }
  if (value !== null && typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    const source = value as Record<string, unknown>;
    const keys = Object.keys(source);
    const isPlainData =
      (prototype === Object.prototype || prototype === null) &&
      !keys.some((key) => typeof source[key] === "function");
    if (isPlainData) {
      const copy: Record<string, unknown> = {};
      for (const key of keys) {
        copy[key] = cloneEndpointValue(source[key]);
      }
      return copy as T;
    }
  }
  return value;
}

export class EndpointConfigState<TConfig extends object> {
  private current: EndpointConfigSnapshot<TConfig>;
  private readonly validateConfig: (config: TConfig) => EndpointValidationResult;
  private readonly normalizeConfig: (config: TConfig) => TConfig;
  private readonly label: string;
  private queue: Promise<unknown> = Promise.resolve();
  private inFlight = 0;

  constructor(initialConfig: TConfig, options: EndpointConfigStateOptions<TConfig>) {
    this.current = {
      config: cloneEndpointValue(initialConfig),
      version: 1,
    };
    this.validateConfig = options.validate;
    this.normalizeConfig = options.normalize ?? ((config) => config);
    this.label = options.label ?? "endpoint";
  }

  public read(): EndpointConfigSnapshot<TConfig> {
    return {
      config: cloneEndpointValue(this.current.config),
      version: this.current.version,
    };
  }

  public getVersion(): number {
    return this.current.version;
  }

  public isUpdateInFlight(): boolean {
    return this.inFlight > 0;
  }

  public commit(
    change: Partial<TConfig> | ((current: Readonly<TConfig>, version: number) => Partial<TConfig>),
    options: EndpointConfigUpdateOptions = {}
  ): EndpointConfigSnapshot<TConfig> {
    const live = this.read();

    if (options.expectedVersion !== undefined && options.expectedVersion !== live.version) {
      throw new EndpointConfigVersionConflictError({
        expectedVersion: options.expectedVersion,
        currentVersion: live.version,
        currentConfig: live.config as Record<string, unknown>,
      });
    }

    const patch =
      typeof change === "function" ? change(live.config, live.version) : change;
    const candidate = { ...live.config, ...patch };
    const normalized = this.normalizeConfig(candidate);
    const validation = this.validateConfig(normalized);
    if (!validation.valid) {
      throw new SdkEndpointError(
        `Invalid ${this.label} configuration update: ${validation.errors.join("; ")}`,
        validation.diagnostics,
        validation.errors,
        "simulate",
        false
      );
    }

    this.current = {
      config: cloneEndpointValue(normalized),
      version: live.version + 1,
    };
    return this.read();
  }

  public async updateSafely(
    options: SafeEndpointConfigUpdateOptions<TConfig>
  ): Promise<EndpointConfigUpdateResult<TConfig>> {
    const maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? 3));
    const task = async (): Promise<EndpointConfigUpdateResult<TConfig>> => {
      this.inFlight++;
      try {
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          const live = this.read();
          const expectedVersion = options.expectedVersion ?? live.version;
          const patch =
            typeof options.change === "function"
              ? await options.change(live.config, live.version)
              : options.change;

          try {
            const committed = this.commit(patch, { expectedVersion });
            return { ...committed, attempts: attempt, retries: attempt - 1 };
          } catch (error) {
            if (!isEndpointConfigVersionConflictError(error)) {
              throw error;
            }
            if (options.expectedVersion !== undefined || attempt === maxAttempts) {
              throw error;
            }
            options.onRetry?.({
              expectedVersion: error.expectedVersion,
              currentVersion: error.currentVersion,
              attempt,
            });
          }
        }
        throw new EndpointConfigVersionConflictError({
          expectedVersion: options.expectedVersion ?? this.current.version,
          currentVersion: this.current.version,
          currentConfig: this.read().config as Record<string, unknown>,
        });
      } finally {
        this.inFlight--;
      }
    };

    const result = this.queue.then(task, task);
    this.queue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }
}

/**
 * Safely resolves or enriches error diagnostics when diagnostic context is
 * missing, incomplete, or malformed.
 */
export function resolveSafeDiagnostics(
  error: unknown,
  fallbackStage: SdkStage = "network-dispatch",
  isExecution = false
): SdkDiagnostic[] {
  // If the error already carries privacy-safe diagnostics, check and return them
  if (
    typeof error === "object" &&
    error !== null &&
    "diagnostics" in error &&
    Array.isArray((error as any).diagnostics) &&
    (error as any).diagnostics.length > 0 &&
    areDiagnosticsPrivacySafe((error as any).diagnostics)
  ) {
    return (error as any).diagnostics;
  }

  // If error has a response body carrying diagnostics (e.g. returned from server routes)
  if (
    typeof error === "object" &&
    error !== null &&
    "responseBody" in error &&
    typeof (error as any).responseBody === "object" &&
    Array.isArray((error as any).responseBody?.diagnostics) &&
    areDiagnosticsPrivacySafe((error as any).responseBody.diagnostics)
  ) {
    return (error as any).responseBody.diagnostics;
  }

  // When context is insufficient (opaque error, empty string, or unclassifiable response)
  const code: SdkDiagnosticCode = isExecution ? "RETRY_UNSAFE" : "CONTEXT_INSUFFICIENT";
  return buildSdkFailureDiagnostics(code, {
    stage: fallbackStage,
    preserveState: true,
  });
}
