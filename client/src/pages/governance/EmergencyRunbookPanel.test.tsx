import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import EmergencyRunbookPanel from "./EmergencyRunbookPanel";
import {
  deriveRunbookProgress,
  EMERGENCY_RUNBOOK_STEPS,
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
