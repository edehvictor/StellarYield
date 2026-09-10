import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { RouteBoundary, RouteLoadingPanel } from "./RouteBoundary";
import {
  classifyRouteFailure,
  logRouteFailure,
} from "../../utils/diagnostics";

// ─── Helpers ────────────────────────────────────────────────────────────────

function Boom({ message = "kaboom from child" }: { message?: string }) {
  throw new Error(message);
}

function makeChunkLoadError(): Error {
  const err = new Error("Loading chunk 42 failed.");
  err.name = "ChunkLoadError";
  return err;
}

// ─── diagnostics unit tests ──────────────────────────────────────────────────

describe("classifyRouteFailure", () => {
  it("returns 'chunk_load_error' for ChunkLoadError name", () => {
    const err = makeChunkLoadError();
    expect(classifyRouteFailure(err)).toBe("chunk_load_error");
  });

  it("returns 'chunk_load_error' for 'Loading chunk N failed' messages", () => {
    const err = new Error("Loading chunk 99 failed.");
    expect(classifyRouteFailure(err)).toBe("chunk_load_error");
  });

  it("returns 'chunk_load_error' for Vite dynamic import messages", () => {
    const err = new Error("Failed to fetch dynamically imported module: /assets/foo.js");
    expect(classifyRouteFailure(err)).toBe("chunk_load_error");
  });

  it("returns 'render_error' for a plain render error", () => {
    expect(classifyRouteFailure(new Error("oops"))).toBe("render_error");
  });

  it("returns 'unknown' for non-Error values", () => {
    expect(classifyRouteFailure("string error")).toBe("unknown");
    expect(classifyRouteFailure(null)).toBe("unknown");
    expect(classifyRouteFailure(42)).toBe("unknown");
  });
});

describe("logRouteFailure", () => {
  it("emits a structured console.error with routeName, failureType, and message", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const error = new Error("test");
    logRouteFailure({ routeName: "analytics", failureType: "chunk_load_error", error });
    expect(spy).toHaveBeenCalledWith(
      "[diagnostics] route failure",
      expect.objectContaining({
        routeName: "analytics",
        failureType: "chunk_load_error",
        message: "test",
      }),
    );
    spy.mockRestore();
  });
});

// ─── RouteBoundary component tests ──────────────────────────────────────────

describe("RouteBoundary", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Suppress expected console.error noise from error boundaries in tests.
    consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it("renders children when there is no error", () => {
    render(
      <RouteBoundary>
        <div>safe content</div>
      </RouteBoundary>,
    );
    expect(screen.queryByText("safe content")).not.toBeNull();
  });

  it("shows the error panel with the real message and does not swallow it", () => {
    render(
      <RouteBoundary>
        <Boom />
      </RouteBoundary>,
    );
    expect(screen.queryByRole("alert")).not.toBeNull();
    expect(screen.queryByText(/kaboom from child/)).not.toBeNull();
    // The real error was logged, not silently discarded.
    expect(consoleSpy).toHaveBeenCalled();
  });

  it("logs the routeName and failureType through diagnostics on render error", () => {
    render(
      <RouteBoundary routeName="analytics">
        <Boom message="render failed" />
      </RouteBoundary>,
    );
    // diagnostics call includes routeName
    expect(consoleSpy).toHaveBeenCalledWith(
      "[diagnostics] route failure",
      expect.objectContaining({ routeName: "analytics", failureType: "render_error" }),
    );
  });

  it("shows 'render_error' failure type badge in the error panel", () => {
    render(
      <RouteBoundary routeName="governance">
        <Boom />
      </RouteBoundary>,
    );
    expect(screen.queryByText("render_error")).not.toBeNull();
    expect(screen.queryByText(/governance/)).not.toBeNull();
  });

  it("offers 'Try again' button for render errors that clears the error on click", () => {
    let shouldThrow = true;
    function MaybeBoom() {
      if (shouldThrow) throw new Error("kaboom from child");
      return <div>recovered</div>;
    }
    render(
      <RouteBoundary>
        <MaybeBoom />
      </RouteBoundary>,
    );
    const btn = screen.getByRole("button", { name: /try again/i });
    expect(btn).not.toBeNull();
    shouldThrow = false;
    fireEvent.click(btn);
    expect(screen.queryByText("recovered")).not.toBeNull();
  });

  it("shows 'Reload page' button for chunk-load errors", () => {
    // Patch getDerivedStateFromError path by throwing an error whose name is ChunkLoadError.
    function ChunkBoom() {
      throw makeChunkLoadError();
    }
    render(
      <RouteBoundary routeName="treasury">
        <ChunkBoom />
      </RouteBoundary>,
    );
    expect(screen.queryByRole("alert")).not.toBeNull();
    expect(screen.queryByText(/Reload page/i)).not.toBeNull();
    // failure type label should be chunk_load_error
    expect(screen.queryByText("chunk_load_error")).not.toBeNull();
  });

  it("logs the routeName and failureType for chunk-load errors", () => {
    function ChunkBoom() {
      throw makeChunkLoadError();
    }
    render(
      <RouteBoundary routeName="treasury">
        <ChunkBoom />
      </RouteBoundary>,
    );
    expect(consoleSpy).toHaveBeenCalledWith(
      "[diagnostics] route failure",
      expect.objectContaining({ routeName: "treasury", failureType: "chunk_load_error" }),
    );
  });

  it("renders an accessible loading panel for the suspense fallback", () => {
    render(<RouteLoadingPanel />);
    expect(screen.queryByRole("status")).not.toBeNull();
  });
});
