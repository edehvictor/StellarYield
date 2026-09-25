#!/usr/bin/env node
/**
 * Maintainer issue triage summary for Stellar Wave.
 *
 * Usage:
 *   GITHUB_TOKEN=ghp_xxx node scripts/issue-triage.js
 *   GITHUB_TOKEN=ghp_xxx GITHUB_REPOSITORY=owner/repo node scripts/issue-triage.js
 *   node scripts/issue-triage.js owner/repo
 *
 * The script uses the GitHub Search API to count issues and pull requests by triage state.
 */

const DEFAULT_REPOSITORY = process.env.GITHUB_REPOSITORY || "edehvictor/StellarYield";
const repository = process.argv[2] || DEFAULT_REPOSITORY;
const token = process.env.GITHUB_TOKEN;

const states = [
  {
    label: "Unclaimed Wave Issues",
    query: `repo:${repository} is:issue is:open label:"Stellar Wave" label:"help wanted" no:assignee`,
  },
  {
    label: "Claimed Wave Issues",
    query: `repo:${repository} is:issue is:open label:"Stellar Wave" assignee:*`,
  },
  {
    label: "PRs Ready for Review",
    query: `repo:${repository} is:pr is:open label:"Stellar Wave" review:required`,
  },
  {
    label: "Blocked Issues",
    query: `repo:${repository} is:issue is:open label:"blocked"`,
  },
  {
    label: "Needs Info",
    query: `repo:${repository} is:issue is:open label:"needs info"`,
  },
];

async function countSearchResults(query) {
  const params = new URLSearchParams({ q: query, per_page: "1" });
  const response = await fetch(`https://api.github.com/search/issues?${params}`, {
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub search failed (${response.status}): ${body}`);
  }

  const data = await response.json();
  return data.total_count;
}

async function runTriage() {
  console.log("📊 StellarYield Maintainer Triage Dashboard");
  console.log("═".repeat(50));
  console.log();
  console.log(`Repository: ${repository}`);

  for (const state of states) {
    const count = await countSearchResults(state.query);
    console.log(`- ${state.label}: ${count}`);
  }

  console.log();
  console.log("💡 Tip: Use GitHub saved searches for detailed lists and docs/triage-process.md for the workflow.");
}

runTriage().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
