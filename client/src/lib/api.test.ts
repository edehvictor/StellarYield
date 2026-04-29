import { describe, expect, it } from "vitest";
import { apiUrl, getApiBaseUrl } from "./api";

describe("api URL helpers", () => {
  const env = (values: Record<string, string>): ImportMetaEnv =>
    ({
      BASE_URL: "/",
      MODE: "test",
      DEV: false,
      PROD: false,
      SSR: false,
      ...values,
    }) as ImportMetaEnv;

  it("uses the local backend by default", () => {
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
});
