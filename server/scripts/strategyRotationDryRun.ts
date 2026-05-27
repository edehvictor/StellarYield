#!/usr/bin/env ts-node
/**
 * Strategy rotation dry-run CLI (#426).
 *
 * Loads candidate data from a JSON file or stdin, evaluates a rotation
 * decision using the production rotation logic, and prints the decision in
 * either JSON or human-readable form. The CLI never mutates rotation state
 * and never enqueues jobs — it only invokes the pure `evaluateRotation`
 * helper, so it is safe to run locally or in CI.
 *
 * Usage:
 *   npx ts-node server/scripts/strategyRotationDryRun.ts --input fixture.json
 *   cat fixture.json | npx ts-node server/scripts/strategyRotationDryRun.ts
 *   npx ts-node server/scripts/strategyRotationDryRun.ts --input fixture.json --format text
 *
 * Input JSON schema (see src/services/strategyRotationDryRun.ts):
 *   {
 *     "context": { currentId, currentScore, lastRotatedAt, candidates: [...] },
 *     "policy": { minScoreDifference, cooldownMs, maxDataAgeMs, minConfidence },
 *     "now": "2026-04-28T12:00:00Z"
 *   }
 */

import { readFileSync } from "fs";
import {
  formatDryRunResult,
  parseDryRunInput,
  runDryRun,
  type DryRunOutputFormat,
} from "../src/services/strategyRotationDryRun";

interface CliOptions {
  inputPath: string | null;
  format: DryRunOutputFormat;
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = { inputPath: null, format: "json" };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--input" || arg === "-i") {
      const next = argv[i + 1];
      if (!next || next.startsWith("-")) {
        throw new Error(`Missing value for ${arg}`);
      }
      opts.inputPath = next;
      i++;
    } else if (arg.startsWith("--input=")) {
      opts.inputPath = arg.slice("--input=".length);
    } else if (arg === "--format" || arg === "-f") {
      const next = argv[i + 1];
      if (next !== "json" && next !== "text") {
        throw new Error(
          `--format must be either "json" or "text" (got ${JSON.stringify(next)}).`,
        );
      }
      opts.format = next;
      i++;
    } else if (arg.startsWith("--format=")) {
      const value = arg.slice("--format=".length);
      if (value !== "json" && value !== "text") {
        throw new Error(
          `--format must be either "json" or "text" (got ${JSON.stringify(value)}).`,
        );
      }
      opts.format = value;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return opts;
}

function printHelp(): void {
  process.stdout.write(
    [
      "Usage: strategyRotationDryRun [--input <path>] [--format json|text]",
      "",
      "Options:",
      "  -i, --input <path>   JSON fixture to evaluate. Reads stdin when omitted.",
      "  -f, --format <mode>  Output mode: 'json' (default) or 'text'.",
      "  -h, --help           Show this help text.",
      "",
      "This command is read-only: no rotation state is written and no jobs are enqueued.",
      "",
    ].join("\n"),
  );
}

function readAllStdin(): string {
  // 0 = stdin; readFileSync handles non-TTY pipes fine.
  return readFileSync(0, "utf8");
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));

  const rawText = opts.inputPath
    ? readFileSync(opts.inputPath, "utf8")
    : readAllStdin();

  if (!rawText.trim()) {
    throw new Error(
      "No input received. Pass --input <path> or pipe JSON via stdin.",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (err) {
    throw new Error(
      `Failed to parse input as JSON: ${(err as Error).message}`,
    );
  }

  const dryRunInput = parseDryRunInput(parsed);
  const result = runDryRun(dryRunInput);
  process.stdout.write(formatDryRunResult(result, opts.format));
  process.stdout.write("\n");
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`strategy-rotation-dry-run: ${message}\n`);
  process.exit(1);
});
