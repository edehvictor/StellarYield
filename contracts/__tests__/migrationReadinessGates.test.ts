import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import gatesJson from "../scripts/migration-readiness-gates.json";

/**
 * Tests for the contract-side migration readiness gates template.
 *
 * The template in contracts/scripts/migration-readiness-gates.json is the
 * source of truth shared between the deployment tooling and the server-side
 * readiness evaluator. These tests guarantee the template stays structurally
 * sound and deterministic so a stale/duplicated gate cannot be silently
 * shipped to operators.
 */

const GATES = (gatesJson as { gates: unknown[] }).gates as Array<Record<string, unknown>>;

const TARGET_AREAS = ["contract", "server", "client", "devops"];
const EVIDENCE_TYPES = [
  "CONTRACT_ADDRESS",
  "YIELD_STATS",
  "SHARE_PRICE_HISTORY",
  "BACKEND_HEALTH",
  "DEPOSIT_AVAILABLE",
  "WITHDRAW_AVAILABLE",
];

describe("migration-readiness-gates.json", () => {
  it("defines a supported schemaVersion", () => {
    expect((gatesJson as { schemaVersion?: string }).schemaVersion).toMatch(/^1\.\d+$/);
  });

  it("covers every known vault slug without duplicates", () => {
    const coverage = (gatesJson as { vaultCoverage?: string[] }).vaultCoverage ?? [];
    const known = ["usdc", "xlm", "xlm-usdc", "xlm-eth", "index", "bluechip"];
    expect(coverage.length).toBeGreaterThan(0);
    for (const slug of coverage) {
      expect(known).toContain(slug);
    }
    expect(new Set(coverage).size).toBe(coverage.length);
  });

  it("lists at least three readiness gates", () => {
    expect(GATES.length).toBeGreaterThanOrEqual(3);
  });

  it("gives every gate a unique id plus required metadata", () => {
    const ids = new Set<string>();
    for (const gate of GATES) {
      expect(typeof gate.id).toBe("string");
      expect(String(gate.id).trim().length).toBeGreaterThan(0);
      expect(ids.has(String(gate.id))).toBe(false);
      ids.add(String(gate.id));

      expect(typeof gate.title).toBe("string");
      expect(typeof gate.description).toBe("string");
      expect(typeof gate.guidance).toBe("string");
      expect(typeof gate.reference).toBe("string");
      expect(TARGET_AREAS).toContain(gate.targetArea);
      expect(EVIDENCE_TYPES).toContain(gate.evidenceType);
    }
  });

  it("keeps every referenced evidence type resolvable by the server", () => {
    for (const gate of GATES) {
      expect(EVIDENCE_TYPES).toContain(gate.evidenceType);
    }
  });

  it("serializes deterministically (stable order and no timestamps)", () => {
    const raw = fs.readFileSync(path.join(__dirname, "../scripts/migration-readiness-gates.json"), "utf8");
    expect(JSON.stringify(JSON.parse(raw), null, 2) + "\n").toBe(raw);
    expect(raw).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(raw).not.toMatch(/\$\{?/);
  });
});