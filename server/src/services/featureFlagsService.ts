/**
 * Feature flag registry.
 *
 * Flags are resolved from environment variables so they can be toggled
 * per-deployment without a code change. Each flag has stable metadata so
 * the diagnostics panel can explain what a flag controls, not just
 * whether it's on.
 */

export type FeatureFlagState = "enabled" | "disabled";

export interface FeatureFlagDefinition {
    key: string;
    envVar: string;
    description: string;
    defaultState: FeatureFlagState;
}

export interface FeatureFlagStatus extends FeatureFlagDefinition {
    state: FeatureFlagState;
    source: "env" | "default";
}

const FEATURE_FLAG_REGISTRY: FeatureFlagDefinition[] = [
    {
        key: "zap-deposits",
        envVar: "FEATURE_ZAP_DEPOSITS",
        description: "Enables one-click zap deposits from non-vault assets.",
        defaultState: "enabled",
    },
    {
        key: "google-sheets-export",
        envVar: "FEATURE_GOOGLE_SHEETS_EXPORT",
        description: "Enables syncing portfolio data to a connected Google Sheet.",
        defaultState: "disabled",
    },
    {
        key: "strategy-simulator",
        envVar: "FEATURE_STRATEGY_SIMULATOR",
        description: "Enables the what-if strategy rotation simulator.",
        defaultState: "enabled",
    },
    {
        key: "donations",
        envVar: "FEATURE_DONATIONS",
        description: "Enables the Yield for Good donation routing feature.",
        defaultState: "enabled",
    },
    {
        key: "indexer-recovery-queue",
        envVar: "FEATURE_INDEXER_RECOVERY_QUEUE",
        description: "Enables manual replay of failed indexer jobs from the admin UI.",
        defaultState: "enabled",
    },
];

function resolveState(flag: FeatureFlagDefinition): FeatureFlagStatus {
    const raw = process.env[flag.envVar];

    if (raw === undefined || raw.trim() === "") {
        return { ...flag, state: flag.defaultState, source: "default" };
    }

    const normalized = raw.trim().toLowerCase();
    const state: FeatureFlagState =
        normalized === "true" || normalized === "1" || normalized === "on"
            ? "enabled"
            : "disabled";

    return { ...flag, state, source: "env" };
}

export function getFeatureFlagStatuses(): FeatureFlagStatus[] {
    return FEATURE_FLAG_REGISTRY.map(resolveState);
}

export function getFeatureFlagStatus(key: string): FeatureFlagStatus | null {
    const flag = FEATURE_FLAG_REGISTRY.find((f) => f.key === key);
    return flag ? resolveState(flag) : null;
}

export function isFeatureEnabled(key: string): boolean {
    return getFeatureFlagStatus(key)?.state === "enabled";
}
