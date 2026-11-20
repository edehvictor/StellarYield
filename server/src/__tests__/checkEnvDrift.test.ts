import {
  parseEnvExample,
  extractEnvReferences,
  checkEnvDriftAgainst,
} from "../../scripts/check-env-drift";

describe("parseEnvExample", () => {
  it("extracts declared variable names, ignoring comments and blank lines", () => {
    const content = `
# Server configuration
NODE_ENV=development
PORT=3001

# Database
DATABASE_URL=
# A commented-out var should not count
# UNUSED_COMMENTED_VAR=
`;
    const declared = parseEnvExample(content);
    expect(declared).toEqual(new Set(["NODE_ENV", "PORT", "DATABASE_URL"]));
  });
});

describe("extractEnvReferences", () => {
  it("finds dot-access references for the given prefix", () => {
    const content = `
      const port = process.env.PORT;
      if (process.env.NODE_ENV === "production") {}
    `;
    const refs = extractEnvReferences(content, "process.env.");
    expect(refs).toEqual(new Set(["PORT", "NODE_ENV"]));
  });

  it("finds bracket-access references", () => {
    const content = `const key = process.env["METRICS_TOKEN"];`;
    const refs = extractEnvReferences(content, "process.env.");
    expect(refs).toEqual(new Set(["METRICS_TOKEN"]));
  });

  it("finds import.meta.env references for the client access pattern", () => {
    const content = `const base = import.meta.env.VITE_API_BASE_URL || "";`;
    const refs = extractEnvReferences(content, "import.meta.env.");
    expect(refs).toEqual(new Set(["VITE_API_BASE_URL"]));
  });

  it("returns an empty set when there are no references", () => {
    const refs = extractEnvReferences("const x = 1;", "process.env.");
    expect(refs.size).toBe(0);
  });
});

describe("checkEnvDriftAgainst", () => {
  it("flags a var declared in .env.example but unused in code as stale", () => {
    const declared = new Set(["USED_VAR", "STALE_VAR"]);
    const result = checkEnvDriftAgainst(
      {
        name: "server",
        accessPrefix: "process.env.",
        sourceFiles: [{ path: "src/index.ts", content: "process.env.USED_VAR" }],
      },
      declared,
    );

    expect(result.stale).toEqual(["STALE_VAR"]);
    expect(result.missing).toEqual([]);
  });

  it("flags a var used in code but missing from .env.example", () => {
    const declared = new Set(["DECLARED_VAR"]);
    const result = checkEnvDriftAgainst(
      {
        name: "server",
        accessPrefix: "process.env.",
        sourceFiles: [
          { path: "src/index.ts", content: "process.env.DECLARED_VAR" },
          { path: "src/config.ts", content: "process.env.UNDOCUMENTED_VAR" },
        ],
      },
      declared,
    );

    expect(result.missing).toEqual(["UNDOCUMENTED_VAR"]);
    expect(result.stale).toEqual([]);
  });

  it("reports no drift when declared and referenced vars match exactly", () => {
    const declared = new Set(["PORT", "NODE_ENV"]);
    const result = checkEnvDriftAgainst(
      {
        name: "server",
        accessPrefix: "process.env.",
        sourceFiles: [
          { path: "src/index.ts", content: "process.env.PORT" },
          { path: "src/config.ts", content: "process.env.NODE_ENV" },
        ],
      },
      declared,
    );

    expect(result.stale).toEqual([]);
    expect(result.missing).toEqual([]);
    expect(result.declaredCount).toBe(2);
    expect(result.referencedCount).toBe(2);
  });

  it("deduplicates references to the same var across multiple files", () => {
    const declared = new Set(["SHARED_VAR"]);
    const result = checkEnvDriftAgainst(
      {
        name: "server",
        accessPrefix: "process.env.",
        sourceFiles: [
          { path: "src/a.ts", content: "process.env.SHARED_VAR" },
          { path: "src/b.ts", content: "process.env.SHARED_VAR" },
        ],
      },
      declared,
    );

    expect(result.referencedCount).toBe(1);
    expect(result.stale).toEqual([]);
    expect(result.missing).toEqual([]);
  });

  it("handles both stale and missing vars in the same package", () => {
    const declared = new Set(["ONLY_DECLARED", "SHARED"]);
    const result = checkEnvDriftAgainst(
      {
        name: "server",
        accessPrefix: "process.env.",
        sourceFiles: [
          { path: "src/a.ts", content: "process.env.SHARED; process.env.ONLY_USED" },
        ],
      },
      declared,
    );

    expect(result.stale).toEqual(["ONLY_DECLARED"]);
    expect(result.missing).toEqual(["ONLY_USED"]);
  });
});
