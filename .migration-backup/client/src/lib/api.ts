const LOCAL_API_BASE_URL = "http://localhost:3001";
const SAME_ORIGIN_API_BASE_URL = "";
const API_UNAVAILABLE_MESSAGE =
  "Backend URL is not configured. Falling back to same-origin API routes.";

export class ApiUnavailableError extends Error {
  constructor(message = API_UNAVAILABLE_MESSAGE) {
    super(message);
    this.name = "ApiUnavailableError";
  }
}

export type ApiBaseUrlState =
  | { available: true; baseUrl: string }
  | { available: false; reason: string };

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function isLocalRuntime(): boolean {
  if (typeof window === "undefined") {
    return true;
  }

  return ["localhost", "127.0.0.1", "::1"].includes(window.location.hostname);
}

export function getApiBaseUrlState(
  env: ImportMetaEnv = import.meta.env,
): ApiBaseUrlState {
  const configured = env.VITE_API_BASE_URL || env.VITE_API_URL;
  if (configured !== undefined && configured !== null && configured.trim() !== "") {
    const trimmed = configured.trim();
    if (!/^https?:\/\//i.test(trimmed)) {
      return {
        available: false,
        reason: `Invalid API URL configuration: "${trimmed}". Must start with http:// or https://`,
      };
    }
    return { available: true, baseUrl: trimTrailingSlash(trimmed) };
  }

  if (isLocalRuntime()) {
    return { available: true, baseUrl: LOCAL_API_BASE_URL };
  }

  return {
    available: false,
    reason: "API base URL configuration is missing.",
  };
}

export function isApiUnavailableError(error: unknown): error is ApiUnavailableError {
  return error instanceof ApiUnavailableError;
}

export function getApiBaseUrl(env: ImportMetaEnv = import.meta.env): string {
  const state = getApiBaseUrlState(env);

  if (!state.available) {
    throw new ApiUnavailableError(state.reason);
  }

  return state.baseUrl;
}

/**
 * Safely get API base URL or null if not configured.
 * Use this when you want to handle missing API gracefully.
 */
export function getApiBaseUrlOrNull(env: ImportMetaEnv = import.meta.env): string | null {
  try {
    return getApiBaseUrl(env);
  } catch {
    return null;
  }
}

export function apiUrl(path: string, env?: ImportMetaEnv): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const state = getApiBaseUrlState(env);

  if (state.available) {
    return `${state.baseUrl}${normalizedPath}`;
  }

  if (state.reason.startsWith("Invalid API URL configuration")) {
    throw new ApiUnavailableError(state.reason);
  }

  return `${SAME_ORIGIN_API_BASE_URL}${normalizedPath}`;
}

/**
 * fetch wrapper that automatically injects a fresh X-Correlation-ID header
 * on every outbound API request so that server request logs can be matched
 * to the originating client action.
 */
export function apiFetch(input: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  headers.set("x-correlation-id", crypto.randomUUID());
  return fetch(input, { ...init, headers });
}
