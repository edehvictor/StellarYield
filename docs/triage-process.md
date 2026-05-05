# Issue and PR Triage Process

This document outlines the triage process for maintaining a healthy and manageable issue tracker in the StellarYield repository.

## 🎯 Overview

The triage system helps maintainers:
- Categorize new issues quickly
- Identify and prioritize important work
- Keep the issue tracker clean and focused
- Support Stellar Wave participants effectively
- Prevent issue tracker bloat from stale issues

## 🤖 Automated Triage

### Daily Workflow (runs at 9:00 AM UTC)

1. **New Issue Triage**: Issues created in the last 3 days without labels are automatically tagged with `needs-triage`
2. **Stale Detection**: Issues inactive for 30 days are marked as `stale`
3. **Stale Closure**: Issues marked `stale` for 14 days without activity are closed
4. **Draft PR Cleanup**: Draft PRs older than 30 days are automatically closed

### Stellar Wave Exemptions

Issues containing "Stellar Wave" in the title or body are:
- Automatically tagged with `stellar-wave` label
- Exempt from stale triage
- Receive special acknowledgment comments

## 🏷️ Label System

### Triage Labels
- **`needs-triage`**: New issues awaiting maintainer review
- **`blocked`**: Issues blocked by dependencies or external factors
- **`keep-active`**: Issues that should never be marked as stale
- **`stellar-wave`**: Stellar Wave program issues (exempt from stale triage)

### Status Labels
- **`stale`**: Issues inactive for extended periods
- **`work-in-progress`**: PRs still being developed
- **`needs-review`**: PRs ready for maintainer review

### Priority Labels
- **`good-first-issue`**: Ideal for newcomers
- **`help-wanted`**: Community assistance needed
- **`enhancement`**: New features or improvements
- **`bug`**: Something isn't working correctly
- **`documentation`**: Documentation improvements
- **`security`**: Security-related issues
- **`pinned`**: Important issues pinned to top

## 📋 Maintainer Triage Checklist

### For New Issues (`needs-triage`)

1. **Review Issue Content**
   - [ ] Clear problem statement?
   - [ ] Reproduction steps provided (for bugs)?
   - [ ] Expected vs actual behavior described?
   - [ ] Relevant environment details included?

2. **Classify and Label**
   - [ ] Add appropriate priority label (`bug`, `enhancement`, `documentation`, etc.)
   - [ ] Add `good-first-issue` if appropriate for newcomers
   - [ ] Add `help-wanted` if community help is needed
   - [ ] Remove `needs-triage` label

3. **Assess Priority**
   - [ ] Is this a security issue? Add `security` label and respond immediately
   - [ ] Is this blocking other work? Add `blocked` or block other issues
   - [ ] Should this be pinned? Add `pinned` label

4. **Assign and Respond**
   - [ ] Assign to appropriate maintainer if possible
   - [ ] Provide initial response or next steps
   - [ ] Link related issues or pull requests

### For Stale Issues (`stale`)

1. **Evaluate Relevance**
   - [ ] Is this issue still relevant to the project?
   - [ ] Has the underlying problem been resolved?
   - [ ] Are there newer related issues?

2. **Take Action**
   - [ ] **Keep Active**: Add `keep-active` label and comment why
   - [ ] **Refresh**: Remove `stale` label and add updated information
   - [ ] **Close**: Let auto-close happen or close manually with explanation

### For Pull Requests

1. **Initial Triage**
   - [ ] Check for proper issue linking
   - [ ] Verify CI checks are passing
   - [ ] Add appropriate labels (`needs-review`, `work-in-progress`)
   - [ ] Assign reviewers if needed

2. **Review Process**
   - [ ] Provide constructive feedback
   - [ ] Request changes if needed
   - [ ] Approve when ready
   - [ ] Merge after approval and CI pass

## 🔄 Manual Triage Process

### Weekly Review (Recommended)

1. **Check `needs-triage` Issues**
   ```bash
   # View all issues needing triage
   gh issue list --repo edehvictor/StellarYield --label "needs-triage"
   ```

2. **Review `stale` Issues**
   ```bash
   # View stale issues
   gh issue list --repo edehvictor/StellarYield --label "stale"
   ```

3. **Check `blocked` Issues**
   ```bash
   # View blocked issues
   gh issue list --repo edehvictor/StellarYield --label "blocked"
   ```

### Monthly Cleanup

1. **Review Old Draft PRs**
   - Contact authors about inactive drafts
   - Close drafts with no response after 30 days

2. **Update Milestones**
   - Review issues with upcoming milestones
   - Update or remove outdated milestones

3. **Label Maintenance**
   - Remove duplicate or misapplied labels
   - Update label descriptions if needed

## 🛠️ Setup and Maintenance

### Initial Setup

1. **Install Required Labels**
   ```bash
   cd .github
   chmod +x setup-labels.sh
   ./setup-labels.sh
   ```

2. **Test Workflow**
   - Manually trigger the stale workflow from GitHub Actions
   - Verify labels are applied correctly
   - Check that comments are posted as expected

### Workflow Maintenance

- **Monitor workflow runs** in GitHub Actions tab
- **Update timing** if the schedule needs adjustment
- **Modify exemptions** if new label categories are added
- **Review message templates** for clarity and tone

## 📊 Metrics and Reporting

### Key Metrics to Track

1. **Triage Efficiency**
   - Time to first response on new issues
   - Percentage of issues triaged within 48 hours
   - Number of stale issues resolved

2. **Issue Health**
   - Ratio of open vs closed issues
   - Age distribution of open issues
   - Frequency of stale issue creation

3. **Community Engagement**
   - Number of `good-first-issue` items completed
   - Participation from new contributors
   - Stellar Wave issue resolution rate

### Reporting

Generate monthly reports using:
```bash
# Example: Get issue statistics
gh issue list --repo edehvictor/StellarYield --state all --limit 1000 | \
  jq -r '.[] | "\(.state),\(.labels[]?.name // "no-label"),\(.created_at)"' | \
  sort | uniq -c
```

## 🚨 Special Cases

### Security Issues
- Never apply `stale` to security issues
- Respond within 24 hours
- Consider private disclosure if needed

### Breaking Changes
- Mark with `keep-active` to prevent auto-close
- Ensure proper communication and migration plans

### Stellar Wave Issues
- Always exempt from stale triage
- Provide additional support and guidance
- Track separately for program reporting

## 📞 Getting Help

- **GitHub Issues**: For triage process improvements
- **Discussions**: For general questions about issue management
- **Maintainer Team**: For urgent triage decisions

Remember: Good triage helps contributors feel heard and keeps the project moving forward! 🚀
