import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  apiUrl,
  getApiBaseUrl,
  getApiBaseUrlState,
  apiFetch,
} from "./api";

describe("api URL helpers", () => {
  const originalWindow = global.window;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    global.window = originalWindow;
  });

  const env = (values: Record<string, string>): ImportMetaEnv =>
    ({
      BASE_URL: "/",
      MODE: "test",
      DEV: false,
      PROD: false,
      SSR: false,
      ...values,
    }) as ImportMetaEnv;

  it("uses the local backend by default when on localhost", () => {
    global.window = { location: { hostname: "localhost" } } as any;
    expect(getApiBaseUrl(env({}))).toBe("http://localhost:3001");
  });

  it("uses the local backend by default for IPv4 and IPv6 local hosts", () => {
    global.window = { location: { hostname: "127.0.0.1" } } as any;
    expect(getApiBaseUrl(env({}))).toBe("http://localhost:3001");

    global.window = { location: { hostname: "::1" } } as any;
    expect(getApiBaseUrl(env({}))).toBe("http://localhost:3001");
  });

  it("prefers VITE_API_BASE_URL and trims trailing slashes", () => {
    expect(
      getApiBaseUrl(env({
        VITE_API_BASE_URL: "https://api.example.com///",
        VITE_API_URL: "https://ignored.example.com",
      })),
    ).toBe("https://api.example.com");
  });

  it("falls back to VITE_API_URL", () => {
    expect(
      getApiBaseUrl(env({
        VITE_API_URL: "https://staging.example.com/",
      })),
    ).toBe("https://staging.example.com");
  });

  it("builds normalized API paths", () => {
    const configuredEnv = env({ VITE_API_BASE_URL: "https://api.example.com/" });
    expect(apiUrl("api/yields", configuredEnv)).toBe("https://api.example.com/api/yields");
    expect(apiUrl("/api/yields", configuredEnv)).toBe("https://api.example.com/api/yields");
  });

  it("returns unavailable state when hosted env vars are missing", () => {
    global.window = { location: { hostname: "stellar-yield-preview.vercel.app" } } as any;

    expect(getApiBaseUrlState(env({}))).toEqual({
      available: false,
      reason: "API base URL configuration is missing.",
    });
    expect(() => getApiBaseUrl(env({}))).toThrow("API base URL configuration is missing.");
  });

  it("returns unavailable state for invalid API URL configurations", () => {
    expect(
      getApiBaseUrlState(env({ VITE_API_BASE_URL: "ftp://api.example.com" })),
    ).toEqual({
      available: false,
      reason: 'Invalid API URL configuration: "ftp://api.example.com". Must start with http:// or https://',
    });

    expect(
      getApiBaseUrlState(env({ VITE_API_BASE_URL: "just-a-string" })),
    ).toEqual({
      available: false,
      reason: 'Invalid API URL configuration: "just-a-string". Must start with http:// or https://',
    });
  });

  it("returns unavailable state when VITE_API_BASE_URL is blank in preview", () => {
    global.window = { location: { hostname: "stellaryield-pr-123.vercel.app" } } as any;
    expect(getApiBaseUrlState(env({ VITE_API_BASE_URL: "" }))).toEqual({
      available: false,
      reason: "API base URL configuration is missing.",
    });
  });
});

describe("apiFetch", () => {
  beforeEach(() => {
    // crypto.randomUUID is not available in jsdom's non-secure context
    vi.stubGlobal("crypto", { randomUUID: () => "test-uuid-1234-5678-abcd" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200 }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("injects x-correlation-id header on every request", async () => {
    await apiFetch("http://localhost:3001/api/fees");

    const [, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers as HeadersInit);
    expect(headers.get("x-correlation-id")).toBe("test-uuid-1234-5678-abcd");
  });

  it("uses a UUID from crypto.randomUUID for the correlation ID", async () => {
    await apiFetch("/api/test");

    const [, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers as HeadersInit);
    expect(headers.get("x-correlation-id")).toBe("test-uuid-1234-5678-abcd");
  });

  it("merges caller-supplied headers without dropping them", async () => {
    await apiFetch("/api/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });

    const [, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers as HeadersInit);
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("x-correlation-id")).toBe("test-uuid-1234-5678-abcd");
  });

  it("preserves other init options (method, body)", async () => {
    await apiFetch("/api/test", {
      method: "DELETE",
      body: "payload",
    });

    const [, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect((init as any).method).toBe("DELETE");
    expect((init as any).body).toBe("payload");
  });
});
