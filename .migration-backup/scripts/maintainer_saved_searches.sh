#!/usr/bin/env bash
# Maintainer triage shortcuts and saved-search examples
# Use these URLs to quickly navigate to important issue views

set -e

REPO="edehvictor/StellarYield"
BASE_URL="https://github.com/$REPO/issues"

echo "🎯 StellarYield Maintainer Saved Searches"
echo "=========================================="
echo

# Option 1: Direct links (for bookmarking)
echo "📋 Saved Search Links (bookmark these in GitHub):"
echo
echo "1️⃣  UNCLAIMED WAVE ISSUES (Ready for contributors):"
echo "    $BASE_URL?q=is%3Aissue+is%3Aopen+label%3A%22Stellar+Wave%22+label%3A%22help+wanted%22+no%3Aassignee"
echo
echo "2️⃣  CLAIMED WAVE ISSUES (In progress, no PR yet):"
echo "    $BASE_URL?q=is%3Aissue+is%3Aopen+label%3A%22Stellar+Wave%22+has%3Aassignee+-linked%3Apr"
echo
echo "3️⃣  WAVE PRs (Pending review):"
echo "    $BASE_URL?q=is%3Apr+is%3Aopen+label%3A%22Stellar+Wave%22"
echo
echo "4️⃣  BLOCKED ISSUES (Waiting on external data):"
echo "    $BASE_URL?q=is%3Aissue+is%3Aopen+label%3Ablocked"
echo
echo "5️⃣  NEEDS INFO (Waiting on contributor response):"
echo "    $BASE_URL?q=is%3Aissue+is%3Aopen+label%3A%22needs+info%22"
echo
echo "6️⃣  ALL OPEN ISSUES:"
echo "    $BASE_URL?q=is%3Aissue+is%3Aopen"
echo

# Option 2: Run GitHub CLI commands (if available)
echo
echo "📊 CLI Commands (requires 'gh' CLI installed):"
echo "=============================================="
echo

if ! command -v gh &> /dev/null; then
  echo "⚠️  GitHub CLI not found. Install with: brew install gh"
  echo "   Then run: gh auth login"
  exit 0
fi

echo "Unclaimed Wave Issues:"
gh issue list --repo "$REPO" --label "Stellar Wave" --label "help wanted" --state open --assignee none --json number,title,labels || echo "(failed — check GITHUB_TOKEN)"
echo

echo "Claimed Wave Issues (no PR yet):"
gh issue list --repo "$REPO" --label "Stellar Wave" --state open --assignee "*" --search "no:linked-pr" --json number,title,assignee || echo "(failed)"
echo

echo "Blocked Issues:"
gh issue list --repo "$REPO" --label "blocked" --state open --json number,title,assignee || echo "(failed)"
echo

echo
echo "💡 Tip: Use 'GITHUB_TOKEN=ghp_xxx node scripts/issue-triage.js' for an automated dashboard"
echo "📖 Full workflow: docs/triage-process.md"
