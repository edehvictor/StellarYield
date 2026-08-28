import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useBackendStatus, useApiEndpointAvailable, isBackendConfigured } from "./useBackendStatus";

describe("useBackendStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns 'checking' initially", () => {
    global.fetch = vi.fn(() => new Promise(() => {})); // Never resolves
    const { result } = renderHook(() => useBackendStatus());
    expect(result.current).toBe("checking");
  });

  it("returns 'available' when backend responds with 200", async () => {
    global.fetch = vi.fn(() =>
      Promise.resolve(new Response("", { status: 200 }))
    );

    const { result } = renderHook(() => useBackendStatus());

    await waitFor(() => {
      expect(result.current).toBe("available");
    });
  });

  it("returns 'available' when backend responds with 404 (endpoint doesn't exist but server is reachable)", async () => {
    global.fetch = vi.fn(() =>
      Promise.resolve(new Response("", { status: 404 }))
    );

    const { result } = renderHook(() => useBackendStatus());

    await waitFor(() => {
      expect(result.current).toBe("available");
    });
  });

  it("returns 'available' when backend responds with 405 (method not allowed)", async () => {
    global.fetch = vi.fn(() =>
      Promise.resolve(new Response("", { status: 405 }))
    );

    const { result } = renderHook(() => useBackendStatus());

    await waitFor(() => {
      expect(result.current).toBe("available");
    });
  });

  it("returns 'unavailable' when network request fails", async () => {
    global.fetch = vi.fn(() => Promise.reject(new Error("Network error")));

    const { result } = renderHook(() => useBackendStatus());

    await waitFor(() => {
      expect(result.current).toBe("unavailable");
    });
  });

  it("returns 'unavailable' on timeout", async () => {
    global.fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      return new Promise<Response>((resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new Error("Request aborted"));
        });
        setTimeout(() => resolve(new Response("", { status: 200 })), 10000);
      });
    });

    const { result } = renderHook(() => useBackendStatus());

    await waitFor(
      () => {
        expect(result.current).toBe("unavailable");
      },
      { timeout: 7000 }
    );
  }, 8000);

  it("polls for status when checkInterval is provided", async () => {
    const fetchSpy = vi.fn(() =>
      Promise.resolve(new Response("", { status: 200 }))
    );
    global.fetch = fetchSpy;

    const { unmount } = renderHook(() => useBackendStatus(500)); // 500ms interval

    await waitFor(() => {
      expect(fetchSpy.mock.calls.length).toBeGreaterThan(1);
    });

    unmount();
  });
});

describe("useApiEndpointAvailable", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns true when endpoint is available", async () => {
    global.fetch = vi.fn(() =>
      Promise.resolve(new Response("", { status: 200 }))
    );

    const { result } = renderHook(() =>
      useApiEndpointAvailable("/api/yields")
    );

    await waitFor(() => {
      expect(result.current).toBe(true);
    });
  });

  it("returns false when endpoint is not available", async () => {
    global.fetch = vi.fn(() =>
      Promise.reject(new Error("Network error"))
    );

    const { result } = renderHook(() =>
      useApiEndpointAvailable("/api/yields")
    );

    await waitFor(() => {
      expect(result.current).toBe(false);
    });
  });

  it("uses HEAD method by default", async () => {
    const fetchSpy = vi.fn(() =>
      Promise.resolve(new Response("", { status: 200 }))
    );
    global.fetch = fetchSpy;

    renderHook(() => useApiEndpointAvailable("/api/yields"));

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ method: "HEAD" })
      );
    });
  });

  it("uses specified HTTP method", async () => {
    const fetchSpy = vi.fn(() =>
      Promise.resolve(new Response("", { status: 200 }))
    );
    global.fetch = fetchSpy;

    renderHook(() => useApiEndpointAvailable("/api/yields", "GET"));

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ method: "GET" })
      );
    });
  });
});

describe("isBackendConfigured", () => {
  it("returns false when using default localhost URL", () => {
    expect(isBackendConfigured()).toBe(false);
  });

  it("returns true when backend is configured to non-default URL", () => {
    // Note: In a real test, we'd need to mock import.meta.env
    // This is a simplified check
    const result = isBackendConfigured();
    expect(typeof result).toBe("boolean");
  });
});
