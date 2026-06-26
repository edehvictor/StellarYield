import { useEffect, useState, useCallback, useRef } from "react";
import { getApiBaseUrl } from "../lib/api";

/**
 * Status of the backend API availability
 */
export type BackendStatus = "checking" | "available" | "unavailable";

/**
 * Hook to check if the backend API is available.
 * Performs a lightweight health check on mount and returns the status.
 * 
 * @param checkInterval - Optional interval to re-check status (in ms). Defaults to no periodic checks.
 * @returns Current status of the backend API
 */
export function useBackendStatus(checkInterval?: number): BackendStatus {
  const [status, setStatus] = useState<BackendStatus>("checking");
  const timeoutRef = useRef<NodeJS.Timeout | undefined>(undefined);

  const checkBackend = useCallback(async () => {
    try {
      const baseUrl = getApiBaseUrl();
      // Use a HEAD request for a lightweight health check
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000); // 5 second timeout

      const response = await fetch(`${baseUrl}/health`, {
        method: "HEAD",
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      // Any successful response (including 404) means the server is reachable
      if (response.ok || response.status === 404 || response.status === 405) {
        setStatus("available");
      } else {
        setStatus("unavailable");
      }
    } catch (error) {
      // Network error, connection refused, or timeout
      setStatus("unavailable");
    }
  }, []);

  useEffect(() => {
    checkBackend();

    if (checkInterval && checkInterval > 0) {
      timeoutRef.current = setInterval(checkBackend, checkInterval);
    }

    return () => {
      if (timeoutRef.current) clearInterval(timeoutRef.current);
    };
  }, [checkBackend, checkInterval]);

  return status;
}

/**
 * Hook to check if a specific API endpoint is available.
 * 
 * @param endpoint - The API endpoint to check (e.g., "/api/yields")
 * @param method - HTTP method to use (default: "HEAD")
 * @returns true if endpoint is available, false otherwise
 */
export function useApiEndpointAvailable(endpoint: string, method: "HEAD" | "GET" = "HEAD"): boolean {
  const [available, setAvailable] = useState(true);

  useEffect(() => {
    const checkEndpoint = async () => {
      try {
        const baseUrl = getApiBaseUrl();
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);

        const response = await fetch(`${baseUrl}${endpoint}`, {
          method,
          signal: controller.signal,
        });

        clearTimeout(timeoutId);
        setAvailable(response.ok || response.status === 405); // 405 means endpoint exists but method not allowed
      } catch {
        setAvailable(false);
      }
    };

    checkEndpoint();
  }, [endpoint, method]);

  return available;
}

/**
 * Checks if the backend is configured (API base URL is not the default localhost).
 * Useful for determining if a production backend is expected.
 */
export function isBackendConfigured(): boolean {
  const baseUrl = getApiBaseUrl();
  return baseUrl !== "http://localhost:3001";
}
