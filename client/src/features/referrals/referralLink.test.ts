import { describe, it, expect } from "vitest";
import {
  resolveAppBaseUrl,
  buildReferralLink,
  DEFAULT_APP_URL,
} from "./referralLink";

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
    expect(resolveAppBaseUrl("   ").isFallback).toBe(true);
  });
});

describe("buildReferralLink", () => {
  it("builds an encoded ?ref link", () => {
    expect(buildReferralLink("https://app.example.com", "GABC/DEF")).toBe(
      "https://app.example.com/?ref=GABC%2FDEF",
    );
  });

  it("returns an empty string without a wallet address", () => {
    expect(buildReferralLink("https://app.example.com", "")).toBe("");
  });
});
