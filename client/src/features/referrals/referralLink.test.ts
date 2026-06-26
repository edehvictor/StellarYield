import { describe, it, expect } from "vitest";
import {
  resolveAppBaseUrl,
  buildReferralLink,
  parseReferralParam,
  normalizeReferralLink,
  isAttributionPreserved,
  DEFAULT_APP_URL,
} from "./referralLink";

const WALLET = "GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ";
const APP_URL = DEFAULT_APP_URL;

describe("resolveAppBaseUrl", () => {
  it("uses the configured URL when present", () => {
    expect(resolveAppBaseUrl("https://app.example.com")).toEqual({
      url: "https://app.example.com",
      isFallback: false,
    });
  });

  it("trims trailing slashes", () => {
    expect(resolveAppBaseUrl("https://app.example.com/").url).toBe(
      "https://app.example.com",
    );
  });

  it("falls back gracefully when missing or blank", () => {
    expect(resolveAppBaseUrl(undefined)).toEqual({
      url: DEFAULT_APP_URL,
      isFallback: true,
    });
    expect(resolveAppBaseUrl("  ")).toEqual({
      url: DEFAULT_APP_URL,
      isFallback: true,
    });
  });

  it("marks a configured URL as non-fallback", () => {
    expect(resolveAppBaseUrl("https://custom.app").isFallback).toBe(false);
  });
});

describe("buildReferralLink", () => {
  it("builds a canonical link with ref param", () => {
    const link = buildReferralLink(APP_URL, WALLET);
    expect(link).toBe(`${APP_URL}/?ref=${encodeURIComponent(WALLET)}`);
  });

  it("accepts a custom base URL", () => {
    const link = buildReferralLink("https://app.example.com/", WALLET);
    expect(link).toContain("https://app.example.com/?ref=");
  });

  it("strips trailing slash from base URL before building", () => {
    const withSlash = buildReferralLink("https://app.example.com/", WALLET);
    const withoutSlash = buildReferralLink("https://app.example.com", WALLET);
    expect(withSlash).toBe(withoutSlash);
  });

  it("encodes special characters in wallet address", () => {
    const link = buildReferralLink(APP_URL, "addr with spaces");
    expect(link).toContain("addr%20with%20spaces");
  });

  it("returns empty string when wallet address is empty", () => {
    expect(buildReferralLink(APP_URL, "")).toBe("");
  });
});

describe("parseReferralParam", () => {
  it("extracts the ref param from a canonical link", () => {
    const link = buildReferralLink(APP_URL, WALLET);
    expect(parseReferralParam(link)).toBe(WALLET);
  });

  it("returns null when no ref param is present", () => {
    expect(parseReferralParam(`${APP_URL}/`)).toBeNull();
  });

  it("returns null for invalid URLs", () => {
    expect(parseReferralParam("not-a-url")).toBeNull();
  });

  it("handles URL with extra query params", () => {
    const url = `${APP_URL}/?ref=${encodeURIComponent(WALLET)}&utm_source=twitter`;
    expect(parseReferralParam(url)).toBe(WALLET);
  });
});

describe("normalizeReferralLink", () => {
  it("returns the canonical form for a canonical link", () => {
    const link = buildReferralLink(APP_URL, WALLET);
    expect(normalizeReferralLink(link)).toBe(link);
  });

  it("strips extra query params while preserving ref attribution", () => {
    const dirty = `${APP_URL}/?utm_source=twitter&ref=${encodeURIComponent(WALLET)}&campaign=spring`;
    const normalized = normalizeReferralLink(dirty);
    expect(normalized).toBe(`${APP_URL}/?ref=${encodeURIComponent(WALLET)}`);
  });

  it("strips hash fragments while preserving ref attribution", () => {
    const withHash = `${APP_URL}/?ref=${encodeURIComponent(WALLET)}#dashboard`;
    const normalized = normalizeReferralLink(withHash);
    expect(normalized).not.toContain("#");
    expect(parseReferralParam(normalized)).toBe(WALLET);
  });

  it("returns original URL unchanged when there is no ref param", () => {
    const url = `${APP_URL}/`;
    expect(normalizeReferralLink(url)).toBe(url);
  });

  it("returns input unchanged for invalid URLs", () => {
    expect(normalizeReferralLink("not-a-url")).toBe("not-a-url");
  });
});

describe("isAttributionPreserved", () => {
  it("returns true when ref is preserved across copy/share", () => {
    const original = buildReferralLink(APP_URL, WALLET);
    const shared = buildReferralLink(APP_URL, WALLET);
    expect(isAttributionPreserved(original, shared)).toBe(true);
  });

  it("returns true when shared URL has extra params but same ref", () => {
    const original = buildReferralLink(APP_URL, WALLET);
    const shared = `${APP_URL}/?ref=${encodeURIComponent(WALLET)}&utm_source=slack`;
    expect(isAttributionPreserved(original, shared)).toBe(true);
  });

  it("returns false when ref is missing from the shared link", () => {
    const original = buildReferralLink(APP_URL, WALLET);
    expect(isAttributionPreserved(original, `${APP_URL}/`)).toBe(false);
  });

  it("returns false when ref changes between original and shared", () => {
    const original = buildReferralLink(APP_URL, WALLET);
    const shared = buildReferralLink(APP_URL, "GDIFFERENTADDRESS");
    expect(isAttributionPreserved(original, shared)).toBe(false);
  });

  it("returns false when original has no ref", () => {
    expect(isAttributionPreserved(`${APP_URL}/`, buildReferralLink(APP_URL, WALLET))).toBe(false);
  });
});
