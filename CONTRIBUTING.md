## 🤝 Contributing to StellarYield

Thanks for contributing to StellarYield, a Stellar-native DeFi yield aggregator and automated vault system. We rely on the community to help build secure, efficient, and accessible DeFi tools.

### 🛑 Before You Start
* **Read the Docs:** Review the `README.md` for overall architecture context.
* **Claim an Issue:** Browse the active issues (especially those tagged for the Stellar Wave) before starting work. Please ask to be assigned before opening a PR.
* **Keep it Focused:** Keep Pull Requests limited to one specific feature, bug fix, or contract concern at a time.
* **Discuss Major Changes:** Start a discussion in the issues tab before changing core architecture, smart contract storage models, or automated routing logic.

### 💻 Local Setup
Since StellarYield is a full-stack monorepo, ensure you have the correct environments set up for the stack you are touching:
* **Smart Contracts:** Install the stable Rust toolchain and the `soroban-cli`. Make sure `rustfmt` and `clippy` are available.
* **Frontend/Backend:** Ensure Node.js (v18+) is installed.

### ✅ Verification Commands
Before submitting a Pull Request, your code must pass the following local checks. PRs with failing checks will not be reviewed.

**For Smart Contracts (`/contracts`):**
```bash
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

**For Frontend & Backend (`/client` and `/server`):**
```bash
npm run lint
npm run test
```

### 🖼️ UI Snapshot Checklist for Visual Reviews
If your PR modifies the frontend or introduces new UI components, you **must** provide UI snapshots (screenshots or short screen recordings).
- **When required:** Any change to CSS, React components, or layout structure.
- **Viewport checks:** Test and provide screenshots for at least:
  - Desktop (1024px+ wide)
  - Mobile (375px wide)
- **No visual changes?** If your PR touches the `/client` directory but does not change the UI (e.g., refactoring logic, updating API calls), explicitly mention **"No visual changes"** in the PR description.

### 📜 Core Contribution Rules
1. **Security First:** Treat vault deposits, withdrawals, fee structures, and rebalancing logic as high-sensitivity areas.
2. **Document State Changes:** Document any smart contract storage or event changes clearly using NatSpec-style comments.
3. **Test Everything:** Add or update unit tests for *every* behavior change. Minimum 90% coverage is expected for financial logic.
4. **Contextual Naming:** Keep variable names and comments specific to StellarYield and Soroban, avoiding generic template wording.

### 🌟 Good First Issue Guidance
If you are adding a "Good First Issue" to the backlog, it should:
* Avoid protocol-level economic or security changes.
* Have a narrow scope (e.g., a single UI component or a read-only view function).
* Include explicit acceptance criteria.
* Be easily testable in isolation.
## Contract Security

Pull requests that touch `contracts/` must pass the checklist in
[docs/contract-security-checklist.md](./docs/contract-security-checklist.md)
before review. The checklist covers storage schema changes, authorization checks,
arithmetic safety, test coverage, and admin permission review.

## CI Failure Artifacts

### 🧪 Running the Fuzzing Suite
The vault includes a property-based testing suite built with `proptest`. To run the fuzz tests:

```bash
cd contracts
cargo test --test fuzz_tests -- --nocapture
```

To run with more iterations (recommended before merging security-sensitive changes):

```bash
PROPTEST_CASES=100000 cargo test --test fuzz_tests -- --nocapture
```

The fuzzing suite validates the following invariants:
* `total_shares` and `total_assets` are never negative
* First depositor receives 1:1 shares
* Full withdrawal returns the exact deposited amount for a sole depositor
* Multi-user deposits produce proportional shares
* Share price never decreases from deposit/withdraw operations
* Rebalance correctly updates tracked assets

### ❓ Questions & Scope
If a change requires touching the client UX, the backend API, *and* the smart contracts, please split that work into separate, sequential Pull Requests to make reviewing easier and safer.
