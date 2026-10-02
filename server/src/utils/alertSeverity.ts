/**
 * Alert severity normalization (#1318).
 *
 * Different services across the backend construct alerts/incidents with
 * inconsistent severity labels — e.g. `healthMonitor.ts` uses
 * `"HIGH"`/`"MEDIUM"`/`"CRITICAL"`, `incidentService.ts` accepts whatever
 * free-text string a caller sends (Prisma's `Incident.severity` column is
 * just `String`), and other services use lowercase variants like `"warning"`
 * or `"error"`. This module provides one canonical `AlertSeverity` enum and
 * a `normalizeSeverity` function that maps known aliases (case-insensitively)
 * onto it, so every service that constructs/emits an alert can converge on
 * the same four levels.
 */

export enum AlertSeverity {
  LOW = "LOW",
  MEDIUM = "MEDIUM",
  HIGH = "HIGH",
  CRITICAL = "CRITICAL",
}

/** Severity used when an input string doesn't match any known alias. */
export const DEFAULT_ALERT_SEVERITY = AlertSeverity.MEDIUM;

/**
 * Known aliases mapped onto the canonical {@link AlertSeverity} levels.
 * Keys are matched case-insensitively (see {@link normalizeSeverity}).
 */
const SEVERITY_ALIASES: Record<string, AlertSeverity> = {
  // LOW
  low: AlertSeverity.LOW,
  info: AlertSeverity.LOW,
  informational: AlertSeverity.LOW,
  notice: AlertSeverity.LOW,
  debug: AlertSeverity.LOW,

  // MEDIUM
  medium: AlertSeverity.MEDIUM,
  moderate: AlertSeverity.MEDIUM,
  warning: AlertSeverity.MEDIUM,
  warn: AlertSeverity.MEDIUM,

  // HIGH
  high: AlertSeverity.HIGH,
  major: AlertSeverity.HIGH,
  error: AlertSeverity.HIGH,
  elevated: AlertSeverity.HIGH,

  // CRITICAL
  critical: AlertSeverity.CRITICAL,
  crit: AlertSeverity.CRITICAL,
  fatal: AlertSeverity.CRITICAL,
  emergency: AlertSeverity.CRITICAL,
  severe: AlertSeverity.CRITICAL,
};

/**
 * Normalizes an arbitrary severity string into a canonical {@link AlertSeverity}.
 *
 * Matching is case-insensitive and trims surrounding whitespace. Unknown or
 * invalid input (including empty strings, `null`, and `undefined`) falls
 * back to {@link DEFAULT_ALERT_SEVERITY} rather than throwing, since severity
 * normalization is meant to make downstream alert handling more robust, not
 * to reject alerts outright.
 */
export function normalizeSeverity(input: string | null | undefined): AlertSeverity {
  if (input == null) {
    return DEFAULT_ALERT_SEVERITY;
  }

  const key = input.trim().toLowerCase();
  if (key === "") {
    return DEFAULT_ALERT_SEVERITY;
  }

  // Already-canonical values (any case) resolve directly.
  const canonicalMatch = Object.values(AlertSeverity).find(
    (level) => level.toLowerCase() === key
  );
  if (canonicalMatch) {
    return canonicalMatch;
  }

  return SEVERITY_ALIASES[key] ?? DEFAULT_ALERT_SEVERITY;
}
