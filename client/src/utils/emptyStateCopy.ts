/**
 * Centralized empty-state copy for consistent UX across panels.
 *
 * Each entry follows the same three-part structure:
 *   title     — short, scannable heading (sentence case, no trailing period)
 *   description — one sentence of context / what to do next
 */

export interface EmptyStateCopy {
  title: string;
  description: string;
}

/* ── Analytics panels ─────────────────────────────────────────────────── */

export const EMPTY_STATE_STRATEGY_HEALTH: EmptyStateCopy = {
  title: "No strategy health data yet",
  description:
    "Health scores will appear here once strategies report a snapshot.",
};

export const EMPTY_STATE_PROVIDER_UPTIME: EmptyStateCopy = {
  title: "No provider uptime data yet",
  description: "Uptime metrics will appear once providers start reporting.",
};

export const EMPTY_STATE_COMPATIBILITY: EmptyStateCopy = {
  title: "No compatibility data yet",
  description: "Add protocols to begin monitoring compatibility.",
};

export const EMPTY_STATE_ATTRIBUTION: EmptyStateCopy = {
  title: "No attribution data yet",
  description:
    "No strategy decisions found in the selected time window.",
};

export const EMPTY_STATE_SOURCE_HEALTH: EmptyStateCopy = {
  title: "No source health data yet",
  description:
    "Yield data source status will appear once sources start reporting.",
};

/* ── Dashboard / chart panels ─────────────────────────────────────────── */

export const EMPTY_STATE_APY: EmptyStateCopy = {
  title: "No APY data yet",
  description:
    "New rates will appear here as protocols report yields.",
};

export const EMPTY_STATE_SHARE_PRICE: EmptyStateCopy = {
  title: "No share price snapshots available",
  description: "No recorded snapshots for this period. Snapshots are taken daily.",
};

export const EMPTY_STATE_APY_HISTORY: EmptyStateCopy = {
  title: "No APY history points available",
  description:
    "The API returned no valid entries for this range.",
};

export const EMPTY_STATE_CORRELATION: EmptyStateCopy = {
  title: "No correlation data available",
  description:
    "There isn't enough position history yet to compute asset correlations.",
};

export const EMPTY_STATE_PROTOCOL_DISTRIBUTION: EmptyStateCopy = {
  title: "No protocol data yet",
  description: "Distribution figures will appear once routing samples are available.",
};

export const EMPTY_STATE_REBALANCE: EmptyStateCopy = {
  title: "No rebalance events yet",
  description: "Rebalances will appear here as they occur.",
};

/* ── Vault panels ─────────────────────────────────────────────────────── */

export const EMPTY_STATE_VAULT_NOT_FOUND: EmptyStateCopy = {
  title: "Vault not found",
  description: "The vault you're looking for doesn't exist or is no longer available.",
};

export const EMPTY_STATE_VAULT_UNAVAILABLE: EmptyStateCopy = {
  title: "Vault data unavailable",
  description:
    "Live vault data is currently unavailable. Please try again later.",
};
