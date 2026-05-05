# GitHub Automation for StellarYield

This directory contains GitHub workflows and automation scripts for the StellarYield repository.

## 📁 Files Overview

### Workflows (`.github/workflows/`)

- **`ci.yml`** - Continuous integration for frontend, backend, and contracts
- **`security.yml`** - Security analysis and vulnerability scanning
- **`ipfs-deploy.yml`** - IPFS deployment automation
- **`stale.yml`** - **NEW** - Stale issue and PR triage workflow

### Configuration Files

- **`labels.yml`** - **NEW** - Label definitions for issue triage
- **`setup-labels.sh`** - **NEW** - Script to create GitHub labels
- **`README.md`** - This file

## 🚀 New Triage System

The repository now includes an automated triage system to manage issues and pull requests effectively.

### Features

- ✅ **Automatic stale detection** (30 days for issues, 21 days for PRs)
- ✅ **Stellar Wave exemptions** - Issues tagged as "stellar-wave" are never marked as stale
- ✅ **New issue triage** - Issues automatically labeled `needs-triage` within 3 days
- ✅ **Draft PR cleanup** - Old draft PRs closed after 30 days
- ✅ **Comprehensive labeling system** with 15+ labels for proper categorization

### Quick Start

1. **Set up the labels:**
   ```bash
   cd .github
   chmod +x setup-labels.sh
   ./setup-labels.sh
   ```

2. **Test the workflow:**
   - Go to GitHub Actions → Stale Issue and PR Triage
   - Click "Run workflow" to test manually

3. **Review the documentation:**
   - See `docs/triage-process.md` for complete maintainer guide

### Schedule

The triage workflow runs daily at 9:00 AM UTC and includes:

- New issue triage (last 3 days)
- Stale issue marking (30+ days inactive)
- Stale issue closure (14 days after marking)
- Draft PR cleanup (30+ days old)

## 📚 Documentation

- **[Triage Process Guide](../docs/triage-process.md)** - Complete maintainer documentation
- **[CONTRIBUTING.md](../CONTRIBUTING.md)** - General contribution guidelines

## 🔧 Maintenance

### Regular Tasks

- **Weekly**: Review `needs-triage` and `stale` issues
- **Monthly**: Update labels and check workflow performance
- **Quarterly**: Review triage metrics and process improvements

### Monitoring

Check GitHub Actions regularly for:
- Workflow execution failures
- Rate limiting warnings
- Label application errors

## 🤝 Contributing

When modifying the triage system:

1. Test changes in a separate branch
2. Verify workflow syntax with GitHub's tools
3. Update documentation accordingly
4. Coordinate with other maintainers

## 📞 Support

For questions about the triage system:
- Create an issue with the `documentation` label
- Tag maintainers for urgent matters
- Review the triage documentation first

---

This automation helps maintain a healthy, manageable issue tracker while supporting the StellarYield community and Stellar Wave participants. 🚀
