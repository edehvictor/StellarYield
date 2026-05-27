export interface AlertPreferences {
  channel: "email" | "in_app";
  cooldownMinutes: number;
  severityThreshold: number;
  quietHoursStart: number;
  quietHoursEnd: number;
}

function inQuietHours(nowHourUtc: number, preferences: AlertPreferences): boolean {
  const { quietHoursStart, quietHoursEnd } = preferences;
  if (quietHoursStart === quietHoursEnd) return false;
  if (quietHoursStart < quietHoursEnd) {
    return nowHourUtc >= quietHoursStart && nowHourUtc < quietHoursEnd;
  }
  return nowHourUtc >= quietHoursStart || nowHourUtc < quietHoursEnd;
}

export function shouldSuppressAlert(
  now: Date,
  previousTriggeredAtMs: number | undefined,
  preferences: AlertPreferences,
): boolean {
  if (inQuietHours(now.getUTCHours(), preferences)) return true;
  if (!previousTriggeredAtMs) return false;
  const elapsedMs = now.getTime() - previousTriggeredAtMs;
  return elapsedMs < preferences.cooldownMinutes * 60_000;
}
