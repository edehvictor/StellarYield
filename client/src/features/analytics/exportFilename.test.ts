import { describe, it, expect } from "vitest";
import { buildExportFilename, sanitizeFilenameSegment } from "./exportFilename";

describe("buildExportFilename", () => {
  it("uses the standardized stellaryield prefix and report type", () => {
    expect(buildExportFilename("snapshot")).toMatch(/^stellaryield-snapshot-/);
  });

  it("includes the current date and the requested extension", () => {
    const today = new Date().toISOString().split("T")[0];
    const name = buildExportFilename("snapshot", "json");
    expect(name).toContain(today);
    expect(name).toMatch(/\.json$/);
  });

  it("produces no unsafe characters even with messy input", () => {
    const name = buildExportFilename("weird report!!", "c sv");
    expect(name).not.toMatch(/[^a-zA-Z0-9._-]/);
  });
});

describe("sanitizeFilenameSegment", () => {
  it("replaces unsafe characters and collapses dots (no traversal)", () => {
    const out = sanitizeFilenameSegment("a/../ b");
    expect(out).not.toContain("..");
    expect(out).not.toMatch(/[^a-zA-Z0-9._-]/);
  });
});
