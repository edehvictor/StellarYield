/**
 * /api/og — Dynamic Open Graph image generator
 *
 * Renders a branded social-card PNG for a given vault using Satori (via
 * @vercel/og).  The image is cached aggressively at the CDN edge so each
 * unique vault/APY combination is only rendered once per cache TTL.
 *
 * @example
 *   GET /api/og?vault=usdc
 *   GET /api/og?vault=xlm-usdc
 *
 * Query parameters:
 *   vault  (required) — vault slug; must exist in VAULT_REGISTRY
 *
 * Response headers:
 *   Cache-Control: public, s-maxage=3600, stale-while-revalidate=86400
 *   Content-Type:  image/png
 */

import React from "react";
import { ImageResponse } from "@vercel/og";
import type { NextRequest } from "next/server";
import { fetchVaultStats, formatTvl, VAULT_REGISTRY } from "../../lib/vaultData";

export const config = { runtime: "edge" };

/** CDN cache: fresh for 1 h, serve stale for up to 24 h while revalidating. */
const CACHE_CONTROL = "public, s-maxage=3600, stale-while-revalidate=86400";

/** OG image dimensions (standard Open Graph). */
const WIDTH = 1200;
const HEIGHT = 630;

// ── Brand tokens ──────────────────────────────────────────────────────────

const COLORS = {
  bg:        "#0D0D14",
  card:      "#16161F",
  border:    "#2A2A3A",
  accent:    "#6C5DD3",
  accentAlt: "#3EAC75",
  textPrimary:   "#FFFFFF",
  textSecondary: "#9CA3AF",
  textMuted:     "#4B5563",
};

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * Renders the social card JSX template.
 * Kept as a pure function so it can be unit-tested independently.
 */
export function buildCardElement(
  vaultName: string,
  asset: string,
  protocol: string,
  apy: number,
  tvl: number,
): React.ReactElement {
  const apyStr = apy > 0 ? `${apy.toFixed(2)}%` : "—";
  const tvlStr = tvl > 0 ? formatTvl(tvl) : "—";

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        width: "100%",
        height: "100%",
        background: COLORS.bg,
        padding: "60px",
        fontFamily: "sans-serif",
        position: "relative",
      }}
    >
      {/* Decorative gradient blob */}
      <div
        style={{
          position: "absolute",
          top: -120,
          right: -120,
          width: 480,
          height: 480,
          borderRadius: "50%",
          background: `radial-gradient(circle, ${COLORS.accent}33 0%, transparent 70%)`,
        }}
      />

      {/* Header: logo + brand */}
      <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 48 }}>
        <div
          style={{
            width: 52,
            height: 52,
            borderRadius: "50%",
            background: `linear-gradient(135deg, ${COLORS.accent}, #9B8AFF)`,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 22,
            fontWeight: 800,
            color: COLORS.textPrimary,
          }}
        >
          SY
        </div>
        <span
          style={{
            fontSize: 26,
            fontWeight: 700,
            color: COLORS.textPrimary,
            letterSpacing: "-0.5px",
          }}
        >
          Stellar Yield
        </span>
      </div>

      {/* Vault name */}
      <div
        style={{
          fontSize: 52,
          fontWeight: 800,
          color: COLORS.textPrimary,
          lineHeight: 1.1,
          marginBottom: 12,
          letterSpacing: "-1px",
        }}
      >
        {vaultName}
      </div>

      {/* Protocol + asset badge */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 56 }}>
        <span
          style={{
            background: `${COLORS.accent}22`,
            border: `1px solid ${COLORS.accent}55`,
            color: COLORS.accent,
            borderRadius: 8,
            padding: "4px 14px",
            fontSize: 16,
            fontWeight: 700,
          }}
        >
          {asset}
        </span>
        <span style={{ color: COLORS.textMuted, fontSize: 16 }}>via {protocol}</span>
      </div>

      {/* Stats row */}
      <div style={{ display: "flex", gap: 32 }}>
        {/* APY card */}
        <div
          style={{
            flex: 1,
            background: COLORS.card,
            border: `1px solid ${COLORS.border}`,
            borderRadius: 20,
            padding: "32px 36px",
            display: "flex",
            flexDirection: "column",
            gap: 8,
          }}
        >
          <span
            style={{ fontSize: 14, fontWeight: 600, color: COLORS.textSecondary, textTransform: "uppercase", letterSpacing: "1px" }}
          >
            Current APY
          </span>
          <span
            style={{ fontSize: 64, fontWeight: 900, color: COLORS.accentAlt, lineHeight: 1 }}
          >
            {apyStr}
          </span>
        </div>

        {/* TVL card */}
        <div
          style={{
            flex: 1,
            background: COLORS.card,
            border: `1px solid ${COLORS.border}`,
            borderRadius: 20,
            padding: "32px 36px",
            display: "flex",
            flexDirection: "column",
            gap: 8,
          }}
        >
          <span
            style={{ fontSize: 14, fontWeight: 600, color: COLORS.textSecondary, textTransform: "uppercase", letterSpacing: "1px" }}
          >
            Total Value Locked
          </span>
          <span
            style={{ fontSize: 64, fontWeight: 900, color: COLORS.textPrimary, lineHeight: 1 }}
          >
            {tvlStr}
          </span>
        </div>
      </div>

      {/* Footer CTA */}
      <div
        style={{
          marginTop: "auto",
          paddingTop: 40,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <span style={{ color: COLORS.textMuted, fontSize: 16 }}>
          Auto-rebalancing yield on Stellar / Soroban
        </span>
        <span
          style={{
            background: `linear-gradient(90deg, ${COLORS.accent}, #9B8AFF)`,
            color: COLORS.textPrimary,
            borderRadius: 12,
            padding: "10px 24px",
            fontSize: 16,
            fontWeight: 700,
          }}
        >
          Deposit Now →
        </span>
      </div>
    </div>
  );
}

// ── Handler ───────────────────────────────────────────────────────────────

/**
 * Edge handler for GET /api/og
 *
 * @param req - Incoming Next.js edge request
 * @returns   PNG image response or a JSON error with appropriate status
 */
export default async function handler(req: NextRequest): Promise<Response> {
  const { searchParams } = new URL(req.url);
  const slug = searchParams.get("vault")?.trim().toLowerCase() ?? "";

  // 400 — unknown vault slug
  if (!slug || !VAULT_REGISTRY[slug]) {
    const known = Object.keys(VAULT_REGISTRY).join(", ");
    return new Response(
      JSON.stringify({ error: `Unknown vault. Valid slugs: ${known}` }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const stats = await fetchVaultStats(slug);

  // Should never happen after the registry check, but guard anyway
  if (!stats) {
    return new Response(
      JSON.stringify({ error: "Failed to resolve vault stats" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }

  const imageResponse = new ImageResponse(
    buildCardElement(stats.name, stats.asset, stats.protocol, stats.apy, stats.tvl),
    {
      width: WIDTH,
      height: HEIGHT,
    },
  );

  // Attach CDN cache headers — ImageResponse doesn't set these by default
  imageResponse.headers.set("Cache-Control", CACHE_CONTROL);

  return imageResponse;
}
