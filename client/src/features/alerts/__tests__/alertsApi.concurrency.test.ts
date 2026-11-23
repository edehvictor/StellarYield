/**
 * alertsApi — optimistic concurrency for alert preferences (#1903).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AlertPreferencesConflictError,
  fetchAlertPreferencesVersioned,
  saveAlertPreferences,
  saveAlertPreferencesVersioned,
  updateAlertPreferencesSafely,
} from "../alertsApi";
import type { AlertPreferences } from "../types";

const prefs = (cooldownMinutes: number): AlertPreferences => ({
  channel: "email",
  cooldownMinutes,
  severityThreshold: 10,
  quietHoursStart: 23,
  quietHoursEnd: 6,
});

function reply(status: number, body: unknown, version?: number): Response {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (version !== undefined) {
    headers.set("ETag", `"${version}"`);
    headers.set("X-Preferences-Version", String(version));
  }
  return new Response(JSON.stringify(body), { status, headers });
}

const conflict = (currentVersion: number, current: AlertPreferences) =>
  reply(
    409,
    {
      error: "Alert preferences changed since version 1; current version is 2. Reload and retry.",
      code: "PREFERENCE_VERSION_CONFLICT",
      currentVersion,
      preferences: current,
    },
    currentVersion,
  );

afterEach(() => {
  vi.restoreAllMocks();
});

describe("versioned reads and writes", () => {
  it("reads the version from the response headers", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(reply(200, prefs(10), 4));
    await expect(fetchAlertPreferencesVersioned("GW", "Blend")).resolves.toEqual({
      preferences: prefs(10),
      version: 4,
    });
  });

  it("returns null when there are no preferences yet", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(reply(404, { error: "not found" }));
    await expect(fetchAlertPreferencesVersioned("GW", "Blend")).resolves.toBeNull();
  });

  it("sends the expected version as If-Match and returns the new version", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(reply(200, prefs(20), 5));
    const saved = await saveAlertPreferencesVersioned("GW", "Blend", prefs(20), {
      expectedVersion: 4,
      operationIdentity: "op-1",
    });
    expect(saved).toEqual({ preferences: prefs(20), version: 5 });
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers["If-Match"]).toBe('"4"');
    expect(headers["X-Operation-Identity"]).toBe("op-1");
  });

  it("sends no If-Match when no version is given (unchanged behaviour)", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(reply(200, prefs(20), 1));
    await expect(saveAlertPreferences("GW", "Blend", prefs(20))).resolves.toEqual(prefs(20));
    const headers = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers["If-Match"]).toBeUndefined();
  });

  it("throws a typed conflict carrying the server's current record", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(conflict(2, prefs(30)));
    const error = await saveAlertPreferencesVersioned("GW", "Blend", prefs(20), {
      expectedVersion: 1,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AlertPreferencesConflictError);
    expect((error as AlertPreferencesConflictError).currentVersion).toBe(2);
    expect((error as AlertPreferencesConflictError).currentPreferences).toEqual(prefs(30));
  });

  it("keeps other 409s (operation identity reuse) as plain errors", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      reply(409, { error: "Operation identity has already been used", code: "OPERATION_IDENTITY_CONFLICT" }),
    );
    const error = await saveAlertPreferencesVersioned("GW", "Blend", prefs(20)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(AlertPreferencesConflictError);
  });
});

describe("updateAlertPreferencesSafely", () => {
  const bumpCooldown = (current: AlertPreferences | null) => ({
    ...(current ?? prefs(0)),
    cooldownMinutes: (current?.cooldownMinutes ?? 0) + 5,
  });

  it("saves against the version it read", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(reply(200, prefs(10), 1))
      .mockResolvedValueOnce(reply(200, prefs(15), 2));
    await expect(updateAlertPreferencesSafely("GW", "Blend", bumpCooldown)).resolves.toEqual({
      preferences: prefs(15),
      version: 2,
    });
    const headers = (fetchMock.mock.calls[1][1] as RequestInit).headers as Record<string, string>;
    expect(headers["If-Match"]).toBe('"1"');
  });

  it("re-applies the change to the newer record after a conflict", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(reply(200, prefs(10), 1))
      .mockResolvedValueOnce(conflict(2, prefs(30)))
      .mockResolvedValueOnce(reply(200, prefs(35), 3));
    const result = await updateAlertPreferencesSafely("GW", "Blend", bumpCooldown);
    expect(result).toEqual({ preferences: prefs(35), version: 3 });
    const retry = fetchMock.mock.calls[2][1] as RequestInit;
    expect((retry.headers as Record<string, string>)["If-Match"]).toBe('"2"');
    // The other writer's 30 was kept and built on, not overwritten with 15.
    expect(JSON.parse(retry.body as string).preferences.cooldownMinutes).toBe(35);
  });

  it("creates with version 0 when nothing exists yet", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(reply(404, { error: "not found" }))
      .mockResolvedValueOnce(reply(200, prefs(5), 1));
    await updateAlertPreferencesSafely("GW", "Blend", bumpCooldown);
    const headers = (fetchMock.mock.calls[1][1] as RequestInit).headers as Record<string, string>;
    expect(headers["If-Match"]).toBe('"0"');
  });

  it("gives up after maxAttempts conflicts", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(reply(200, prefs(10), 1))
      .mockResolvedValueOnce(conflict(2, prefs(20)))
      .mockResolvedValueOnce(conflict(3, prefs(25)));
    await expect(updateAlertPreferencesSafely("GW", "Blend", bumpCooldown, 2)).rejects.toBeInstanceOf(
      AlertPreferencesConflictError,
    );
  });

  it("does not retry validation or server errors", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(reply(200, prefs(10), 1))
      .mockResolvedValueOnce(reply(400, { error: "preferences.cooldownMinutes must be between 0 and 1440" }));
    await expect(updateAlertPreferencesSafely("GW", "Blend", bumpCooldown)).rejects.toThrow(
      "cooldownMinutes",
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
