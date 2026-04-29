#!/bin/bash

# Setup script for GitHub labels in StellarYield repository
# Usage: ./setup-labels.sh
# Requires: GitHub CLI (gh) to be installed and authenticated

set -e

REPO="edehvictor/StellarYield"

echo "Setting up labels for $REPO..."

# Define labels with their properties
declare -A labels=(
    ["needs-triage"]="fbca04|Issue needs maintainer review and classification"
    ["blocked"]="e11d21|Issue is blocked by dependencies or external factors"
    ["keep-active"]="1d76db|Issue should remain active and not be marked as stale"
    ["stellar-wave"]="795548|Stellar Wave program issue - exempt from stale triage"
    ["stale"]="eeeeee|Issue has been inactive for an extended period"
    ["work-in-progress"]="ededed|Pull request is still being developed"
    ["needs-review"]="fbca04|Pull request needs maintainer review"
    ["good-first-issue"]="7057ff|Good for newcomers to the project"
    ["help-wanted"]="008672|Community help is needed"
    ["enhancement"]="a2eeef|New feature or improvement"
    ["bug"]="d73a4a|Something isn't working correctly"
    ["documentation"]="0075ca|Improvements or additions to documentation"
    ["security"]="ee0701|Security-related issue or vulnerability"
    ["pinned"]="ffffff|Important issue pinned to the top"
)

# Create or update each label
for label in "${!labels[@]}"; do
    IFS='|' read -r color description <<< "${labels[$label]}"
    
    echo "Creating/updating label: $label"
    
    # Check if label exists
    if gh label list --repo "$REPO" --search "$label" --limit 1 | grep -q "$label"; then
        # Update existing label
        gh label edit "$label" --repo "$REPO" --color "$color" --description "$description"
        echo "✅ Updated existing label: $label"
    else
        # Create new label
        gh label create "$label" --repo "$REPO" --color "$color" --description "$description"
        echo "✅ Created new label: $label"
    fi
done

echo ""
echo "🎉 All labels have been set up successfully!"
echo ""
echo "Next steps:"
echo "1. Review the labels in your GitHub repository"
echo "2. Check the triage documentation at docs/triage-process.md"
echo "3. Test the stale workflow by running it manually"
