const LOCAL_API_BASE_URL = "http://localhost:3001";

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

export function getApiBaseUrl(env: ImportMetaEnv = import.meta.env): string {
  const configured = env.VITE_API_BASE_URL || env.VITE_API_URL;
  if (configured?.trim()) {
    return trimTrailingSlash(configured.trim());
  }

  const isLocalhost = typeof window !== 'undefined' 
    ? window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
    : true;

  if (!isLocalhost) {
    throw new Error("API_UNAVAILABLE: Backend URL not configured for preview environment. Please set VITE_API_BASE_URL.");
  }

  return LOCAL_API_BASE_URL;
}

export function apiUrl(path: string, env?: ImportMetaEnv): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${getApiBaseUrl(env)}${normalizedPath}`;
}
