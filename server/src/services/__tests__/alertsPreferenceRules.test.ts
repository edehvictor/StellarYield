import { shouldSuppressAlert } from "../alertsPreferenceRules";

describe("alert preference suppression rules", () => {
  const prefs = {
    channel: "email" as const,
    cooldownMinutes: 60,
    severityThreshold: 5,
    quietHoursStart: 23,
    quietHoursEnd: 6,
  };

  it("suppresses during quiet hours", () => {
    const now = new Date("2026-05-26T23:30:00Z");
    expect(shouldSuppressAlert(now, undefined, prefs)).toBe(true);
  });

  it("suppresses while cooldown is active", () => {
    const now = new Date("2026-05-26T12:30:00Z");
    const previous = new Date("2026-05-26T12:00:00Z").getTime();
    expect(shouldSuppressAlert(now, previous, prefs)).toBe(true);
  });

  it("allows alerts outside quiet hours and after cooldown", () => {
    const now = new Date("2026-05-26T14:30:00Z");
    const previous = new Date("2026-05-26T12:00:00Z").getTime();
    expect(shouldSuppressAlert(now, previous, prefs)).toBe(false);
  });
});
