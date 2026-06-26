import { describe, it, expect } from "vitest";
import {
  buildReferralLink,
  parseReferralParam,
  normalizeReferralLink,
  isAttributionPreserved,
} from "./referralLink";

const WALLET = "GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ";
const APP_URL = "https://stellaryield.vercel.app";

describe("buildReferralLink", () => {
  it("builds a canonical link with ref param", () => {
    const link = buildReferralLink(WALLET);
    expect(link).toBe(`${APP_URL}/?ref=${encodeURIComponent(WALLET)}`);
  });

  it("accepts a custom app URL", () => {
    const link = buildReferralLink(WALLET, "https://app.example.com/");
    expect(link).toContain("https://app.example.com/?ref=");
  });

  it("strips trailing slash from app URL before building", () => {
    const withSlash = buildReferralLink(WALLET, "https://app.example.com/");
    const withoutSlash = buildReferralLink(WALLET, "https://app.example.com");
    expect(withSlash).toBe(withoutSlash);
  });

  it("encodes special characters in wallet address", () => {
    const link = buildReferralLink("addr with spaces");
    expect(link).toContain("addr%20with%20spaces");
  });
});

describe("parseReferralParam", () => {
  it("extracts the ref param from a canonical link", () => {
    const link = buildReferralLink(WALLET);
    expect(parseReferralParam(link)).toBe(WALLET);
  });

  it("returns null when no ref param is present", () => {
    expect(parseReferralParam("https://stellaryield.vercel.app/")).toBeNull();
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
    const link = buildReferralLink(WALLET);
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
    const original = buildReferralLink(WALLET);
    const shared = buildReferralLink(WALLET);
    expect(isAttributionPreserved(original, shared)).toBe(true);
  });

  it("returns true when shared URL is a normalized form of the original", () => {
    const original = buildReferralLink(WALLET);
    const shared = `${APP_URL}/?ref=${encodeURIComponent(WALLET)}&utm_source=slack`;
    expect(isAttributionPreserved(original, shared)).toBe(true);
  });

  it("returns false when ref is missing from the shared link", () => {
    const original = buildReferralLink(WALLET);
    const shared = `${APP_URL}/`;
    expect(isAttributionPreserved(original, shared)).toBe(false);
  });

  it("returns false when ref changes between original and shared", () => {
    const original = buildReferralLink(WALLET);
    const shared = buildReferralLink("GDIFFERENTADDRESS");
    expect(isAttributionPreserved(original, shared)).toBe(false);
  });

  it("returns false when original has no ref", () => {
    expect(isAttributionPreserved(`${APP_URL}/`, buildReferralLink(WALLET))).toBe(false);
  });
});
