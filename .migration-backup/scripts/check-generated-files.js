#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const FORBIDDEN_PATTERNS = [
  { pattern: /^issue\.md$/i, label: "issue.md" },
  { pattern: /^pr\.md$/i, label: "pr.md" },
];

const REPO_ROOT = path.resolve(__dirname, "..");

function getChangedFiles() {
  try {
    const mergeBase = execSync(
      "git merge-base HEAD origin/main 2>/dev/null || echo HEAD",
      { encoding: "utf8", cwd: REPO_ROOT }
    ).trim();

    const output = execSync(
      `git diff --name-only ${mergeBase}..HEAD 2>/dev/null`,
      { encoding: "utf8", cwd: REPO_ROOT }
    ).trim();

    return output ? output.split("\n") : [];
  } catch {
    return [];
  }
}

let violations = [];

const changedFiles = getChangedFiles();

for (const filePath of changedFiles) {
  const fileName = path.basename(filePath);
  for (const entry of FORBIDDEN_PATTERNS) {
    if (entry.pattern.test(fileName)) {
      violations.push({
        file: filePath,
        label: entry.label,
      });
    }
  }
}

if (violations.length > 0) {
  console.error("\n\u274c Forbidden generated files detected in this branch:\n");
  for (const v of violations) {
    console.error(`  ${v.file}`);
  }
  console.error(
    "\nGenerated issue/PR scripts (issue.md, pr.md) must not be committed.\n" +
    "These files are auto-generated operational artifacts meant for local use only.\n" +
    "Remove them from the branch before merging.\n"
  );
  process.exit(1);
} else {
  console.log("\u2705 No forbidden generated files detected in this branch.");
  process.exit(0);
}
