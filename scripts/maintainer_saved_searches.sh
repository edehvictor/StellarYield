#!/usr/bin/env bash
# Lightweight saved-search examples for maintainers
echo "--- Open issues tagged 'unassigned' ---"
gh issue list --label unassigned --state open || echo "(run 'gh' CLI or view in GitHub)"
echo
echo "--- Recent strategy rotation failures (from logs) ---"
grep -R "rotation" -n server || echo "(no local logs)"
echo
echo "--- Recent portfolio deltas > material ---"
node -e "console.log('Run reconciliation script or API to list material deltas')"
