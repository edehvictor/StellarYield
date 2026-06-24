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

export function apiUrl(path: string, env?: ImportMetaEnv): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${getApiBaseUrl(env)}${normalizedPath}`;
}
