#714 Add checked arithmetic and property tests to the matching engine fee and settlement math
Repo Avatar
edehvictor/StellarYield
Summary
Matching and settlement calculations should use explicit arithmetic guarantees so fee and fill math cannot overflow, underflow, or drift silently.

Scope
Replace unchecked arithmetic in fee and settlement helpers
Define and document rounding rules
Add property-style or exhaustive edge-case tests
Acceptance Criteria
Math errors return explicit failures
Settlement and fee invariants are covered by tests


#719 Wire rewards Merkle generation to on-chain distributor verification with anti-double-claim tests
Repo Avatar
edehvictor/StellarYield
Summary
Connect off-chain reward tree generation to contract-side proof verification and claim tracking.

Scope
Define canonical reward leaf encoding
Generate fixtures shared by server or scripts and contracts
Prevent duplicate claims per campaign or epoch
Acceptance Criteria
Valid proofs verify on-chain
Wrong recipient, wrong amount, or repeated claims are rejected

#717 Remove browser-exposed secret configuration and add CI guardrails for frontend env variables
Repo Avatar
edehvictor/StellarYield
Summary
Audit public frontend environment variables and move secret-dependent behavior behind server-side endpoints.

Scope
Identify unsafe VITE_ secrets or privileged keys
Move sensitive calls to server-owned routes
Add CI checks for unsafe frontend env names
Acceptance Criteria
Frontend builds do not depend on privileged secrets
CI fails when new browser-exposed secret patterns are introduced


#248 Cross-Protocol Yield Opportunity Ranking Engine
Repo Avatar
edehvictor/StellarYield
Description
We need an engine that ranks live yield opportunities across supported Stellar DeFi protocols using APY, TVL, volatility, liquidity depth, and protocol risk signals.

Acceptance Criteria

Build a backend ranking module that scores vault and liquidity opportunities across multiple protocols.
Include configurable weighting for APY, liquidity, protocol maturity, and volatility.
Expose a normalized ranked opportunities API for frontend consumption.
Add tests covering score calculation, tie-breaking, and missing provider data.
Technical Details
Stack: Node.js, TypeScript, Express.
Location: server/src/services/, server/src/routes/.
Security: Rankings must not silently trust malformed or stale upstream data.

Complexity & Scope
Estimated Time: 3-4 weeks.
Drips Complexity: High (200 points).

Guidelines for Submission
Minimum 90 percent test coverage required.
Clear documentation must be added to public modules and route contracts.
Timeframe for completion: 2 Wave cycles.


