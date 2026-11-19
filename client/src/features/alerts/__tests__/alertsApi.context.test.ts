/**
 * alertsApi — network/ledger context binding (#1908).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ALERT_PREFERENCE_SCHEMA_VERSION,
  AlertPreferencesConflictError,
  AlertPreferencesContextConflictError,
  buildAlertPreferenceContext,
  createAlert,
  fetchAlertPreferencesVersioned,
  rebindAlertPreferenceContext,
  saveAlertPreferencesVersioned,
  updateAlertPreferencesSafely,
} from "../alertsApi";
import type { AlertPreferenceContext, AlertPreferences } from "../types";

const PASSPHRASE = "Test SDF Network ; September 2015";
const VAULT = "Blend";
const context: AlertPreferenceContext = {
  networkPassphrase: PASSPHRASE,
  vaultId: VAULT.toLowerCase(),
  schemaVersion: ALERT_PREFERENCE_SCHEMA_VERSION,
};

const prefs = (cooldownMinutes: number): AlertPreferences => ({
  channel: "email",
  cooldownMinutes,
  severityThreshold: 10,
  quietHoursStart: 23,
  quietHoursEnd: 6,
});

function reply(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

const headersOf = (call: [string, RequestInit | undefined]) =>
  call[1]?.headers as Record<string, string>;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("alert preference context", () => {
  it("derives the context from the configured network", () => {
    expect(buildAlertPreferenceContext("BLEND")).toEqual(context);
  });

  it("sends the context on reads and rejects a 409 context conflict", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      reply(409, {
        code: "PREFERENCE_CONTEXT_CONFLICT",
        reason: "STORED_CONTEXT_MISMATCH",
        error: "bound elsewhere",
        currentContext: { networkId: "a".repeat(64), vaultId: VAULT, schemaVersion: 1 },
      }),
    );

    const error = await fetchAlertPreferencesVersioned("GW", VAULT, { context }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(AlertPreferencesContextConflictError);
    expect((error as AlertPreferencesContextConflictError).reason).toBe("STORED_CONTEXT_MISMATCH");
    expect(headersOf(fetchMock.mock.calls[0])["X-Alert-Network-Passphrase"]).toBe(PASSPHRASE);
    expect(headersOf(fetchMock.mock.calls[0])["X-Alert-Schema-Version"]).toBe("1");
  });

  it("writes the context explicitly and keeps version conflicts distinct", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      reply(409, {
        code: "PREFERENCE_VERSION_CONFLICT",
        error: "stale version",
        currentVersion: 3,
        preferences: prefs(30),
      }),
    );

    const error = await saveAlertPreferencesVersioned("GW", VAULT, prefs(10), {
      context,
      expectedVersion: 2,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AlertPreferencesConflictError);
    expect((error as AlertPreferencesConflictError).currentVersion).toBe(3);
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(init.body as string).context).toEqual(context);
    expect(headersOf(fetchMock.mock.calls[0])["X-Alert-Network-Passphrase"]).toBe(PASSPHRASE);
  });

  it("does not retry a context conflict during a safe update", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(reply(200, prefs(10), { "X-Preferences-Version": "1" }))
      .mockResolvedValueOnce(
        reply(409, {
          code: "PREFERENCE_CONTEXT_CONFLICT",
          reason: "WRONG_NETWORK",
          error: "wrong network",
        }),
      );

    await expect(
      updateAlertPreferencesSafely("GW", VAULT, (current) => ({
        ...(current ?? prefs(0)),
        cooldownMinutes: 5,
      }), 3, { context }),
    ).rejects.toBeInstanceOf(AlertPreferencesContextConflictError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("binds initial preferences created with an alert", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      reply(201, { id: "a1", status: "active" }),
    );

    await createAlert({
      walletAddress: "GW",
      vaultId: VAULT,
      condition: "above",
      thresholdValue: 10,
      preferences: prefs(10),
    });
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(init.body as string).context).toEqual(context);
    expect(headersOf(fetchMock.mock.calls[0])["X-Alert-Schema-Version"]).toBe("1");
  });

  it("posts the old context when rebinding after a network transition", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      reply(200, {
        preferences: prefs(10),
        version: 2,
        context: { networkId: "b".repeat(64), vaultId: VAULT, schemaVersion: 1 },
        replayed: false,
      }),
    );

    const result = await rebindAlertPreferenceContext("GW", VAULT, context, 1);
    expect(result.version).toBe(2);
    expect(fetchMock.mock.calls[0][0]).toContain(
      `/api/alerts/GW/preferences/${VAULT}/rebind`,
    );
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(init.body as string)).toEqual({ context, expectedVersion: 1 });
  });
});
