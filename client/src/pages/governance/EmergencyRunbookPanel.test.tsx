import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import EmergencyRunbookPanel from "./EmergencyRunbookPanel";
import {
  deriveRunbookProgress,
  EMERGENCY_RUNBOOK_STEPS,
  createEmptyPersistedState,
  acknowledgeStep,
  recordStepFailure,
  startIncident,
  resetRunbookState,
  deriveRunWithPersistence,
  loadRunbookState,
  saveRunbookState,
} from "./emergencyRunbook";

describe("deriveRunbookProgress", () => {
  it("is nominal with no current step when running and healthy", () => {
    const progress = deriveRunbookProgress({ isPaused: false, healthy: true });
    expect(progress.phase).toBe("nominal");
    expect(progress.steps.every((s) => s.state === "upcoming")).toBe(true);
  });

  it("makes pause the current step when health degrades before pausing", () => {
    const progress = deriveRunbookProgress({ isPaused: false, healthy: false });
    expect(progress.phase).toBe("incident");
    expect(progress.steps.find((s) => s.id === "pause")?.state).toBe("current");
  });

  it("completes pause and activates verify while paused and unhealthy", () => {
    const progress = deriveRunbookProgress({ isPaused: true, healthy: false });
    expect(progress.steps.find((s) => s.id === "pause")?.state).toBe("complete");
    expect(progress.steps.find((s) => s.id === "verify")?.state).toBe("current");
  });

  it("advances to notify once paused and health has recovered", () => {
    const progress = deriveRunbookProgress({ isPaused: true, healthy: true });
    expect(progress.steps.find((s) => s.id === "pause")?.state).toBe("complete");
    expect(progress.steps.find((s) => s.id === "verify")?.state).toBe("complete");
    expect(progress.steps.find((s) => s.id === "notify")?.state).toBe("current");
  });
});

describe("EmergencyRunbookPanel", () => {
  it("renders every runbook step as a checklist", () => {
    render(<EmergencyRunbookPanel status={{ isPaused: true, healthy: false }} />);
    for (const step of EMERGENCY_RUNBOOK_STEPS) {
      expect(screen.getByTestId(`runbook-step-${step.id}`)).toBeInTheDocument();
    }
  });

  it("renders every privileged action button as disabled (read-only)", () => {
    render(<EmergencyRunbookPanel status={{ isPaused: false, healthy: false }} />);
    for (const step of EMERGENCY_RUNBOOK_STEPS) {
      const button = screen.getByRole("button", { name: step.actionLabel });
      expect(button).toBeDisabled();
    }
  });

  it("reflects the current pause and health status", () => {
    render(<EmergencyRunbookPanel status={{ isPaused: true, healthy: true }} />);
    expect(screen.getByText("Protocol: Paused")).toBeInTheDocument();
    expect(screen.getByText("Health: OK")).toBeInTheDocument();
  });
});

describe("runbook state persistence", () => {
  it("creates empty state with no acknowledged steps", () => {
    const state = createEmptyPersistedState();
    expect(state.acknowledgedSteps).toEqual([]);
    expect(state.incidentStartedAt).toBeNull();
    expect(state.failedStepAttempts).toEqual({});
  });

  it("acknowledges a step", () => {
    let state = createEmptyPersistedState();
    state = acknowledgeStep(state, "notify");
    expect(state.acknowledgedSteps).toContain("notify");
  });

  it("does not duplicate acknowledgements", () => {
    let state = createEmptyPersistedState();
    state = acknowledgeStep(state, "notify");
    state = acknowledgeStep(state, "notify");
    expect(state.acknowledgedSteps.filter((s) => s === "notify")).toHaveLength(1);
  });

  it("records step failures", () => {
    let state = createEmptyPersistedState();
    state = recordStepFailure(state, "pause");
    state = recordStepFailure(state, "pause");
    expect(state.failedStepAttempts["pause"]).toBe(2);
  });

  it("starts incident and preserves timestamp", () => {
    let state = createEmptyPersistedState();
    state = startIncident(state);
    expect(state.incidentStartedAt).toBeTruthy();
    const firstTimestamp = state.incidentStartedAt;
    state = startIncident(state);
    expect(state.incidentStartedAt).toBe(firstTimestamp);
  });

  it("resets state completely", () => {
    let state = createEmptyPersistedState();
    state = acknowledgeStep(state, "notify");
    state = recordStepFailure(state, "pause");
    state = startIncident(state);
    state = resetRunbookState(state);
    expect(state.acknowledgedSteps).toEqual([]);
    expect(state.incidentStartedAt).toBeNull();
    expect(state.failedStepAttempts).toEqual({});
  });
});

describe("runbook recovery after reload", () => {
  it("restores acknowledged steps from persisted state", () => {
    const status = { isPaused: true, healthy: true };
    let persisted = createEmptyPersistedState();
    persisted = acknowledgeStep(persisted, "notify");

    const result = deriveRunWithPersistence(status, persisted);
    const notifyStep = result.steps.find((s) => s.id === "notify");
    expect(notifyStep?.state).toBe("complete");
  });

  it("advances past acknowledged steps to next current", () => {
    const status = { isPaused: true, healthy: true };
    let persisted = createEmptyPersistedState();
    persisted = acknowledgeStep(persisted, "notify");

    const result = deriveRunWithPersistence(status, persisted);
    const resumeStep = result.steps.find((s) => s.id === "resume");
    expect(resumeStep?.state).toBe("current");
  });

  it("handles partial failure recovery", () => {
    const status = { isPaused: false, healthy: false };
    let persisted = createEmptyPersistedState();
    persisted = recordStepFailure(persisted, "pause");
    persisted = recordStepFailure(persisted, "pause");

    const result = deriveRunWithPersistence(status, persisted);
    expect(result.persisted.failedStepAttempts["pause"]).toBe(2);
    const pauseStep = result.steps.find((s) => s.id === "pause");
    expect(pauseStep?.state).toBe("current");
  });

  it("nominal phase shows all upcoming even with persisted acknowledgements", () => {
    const status = { isPaused: false, healthy: true };
    let persisted = createEmptyPersistedState();
    persisted = acknowledgeStep(persisted, "notify");

    const result = deriveRunWithPersistence(status, persisted);
    expect(result.phase).toBe("nominal");
  });
});

describe("runbook storage round-trip", () => {
  function createMockStorage(): Storage {
    const store = new Map<string, string>();
    return {
      get length() { return store.size; },
      clear() { store.clear(); },
      getItem(key: string) { return store.get(key) ?? null; },
      setItem(key: string, value: string) { store.set(key, value); },
      removeItem(key: string) { store.delete(key); },
      key(index: number) { return [...store.keys()][index] ?? null; },
    };
  }

  it("round-trips state through storage", () => {
    const storage = createMockStorage();
    let state = createEmptyPersistedState();
    state = acknowledgeStep(state, "notify");
    state = recordStepFailure(state, "pause");
    state = startIncident(state);
    saveRunbookState(storage, state);

    const loaded = loadRunbookState(storage);
    expect(loaded.acknowledgedSteps).toContain("notify");
    expect(loaded.failedStepAttempts["pause"]).toBe(1);
    expect(loaded.incidentStartedAt).toBeTruthy();
  });

  it("returns empty state when storage is null", () => {
    const loaded = loadRunbookState(null);
    expect(loaded.acknowledgedSteps).toEqual([]);
  });

  it("returns empty state when storage is corrupted", () => {
    const storage = createMockStorage();
    storage.setItem("stellar_yield_runbook_state", "not-json");
    const loaded = loadRunbookState(storage);
    expect(loaded.acknowledgedSteps).toEqual([]);
  });
});
