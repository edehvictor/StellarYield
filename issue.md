#209 Add backend metrics endpoint for API latency and cache status
Repo Avatar
edehvictor/StellarYield
Description
Operators should be able to inspect basic backend metrics such as request latency, cache age, and provider health.

Acceptance Criteria

Add a protected or development-only metrics endpoint.
Track route latency, cache hit/miss counts, and provider status.
Avoid exposing secrets or user private data.
Add tests for metrics response shape.
Technical Details

Location: server/src/routes/, monitoring modules.
Complexity and Scope
Estimated Time: 2-4 days.
Complexity: Medium.


#210 Add data freshness indicators to yield cards
Repo Avatar
edehvictor/StellarYield
Description
Users should know when APY and TVL data was last updated so stale data is visible.

Acceptance Criteria

Display fetched-at or updated-at timestamps on yield cards.
Show stale badges when data is older than the configured freshness window.
Handle missing timestamps gracefully.
Add tests for fresh, stale, and missing timestamp states.
Technical Details

Location: client/src/components/dashboard/, yield data types.
Complexity and Scope
Estimated Time: 1-2 days.
Complexity: Low.

#211 Add protocol risk badge explanations
Repo Avatar
edehvictor/StellarYield
Description
Risk scores should be understandable at a glance. Add short explanations for risk badges shown in protocol cards and AI advisor output.

Acceptance Criteria

Add tooltip or expandable explanation for risk score levels.
Explain factors such as TVL, volatility, protocol maturity, and data freshness.
Ensure explanations are accessible by keyboard.
Add tests for rendering each risk level.
Technical Details

Location: dashboard cards, AI advisor components.
Complexity and Scope
Estimated Time: 1-2 days.
Complexity: Low.

#213 Add smoke test script for deployed frontend and backend
Repo Avatar
edehvictor/StellarYield
Description
After deployment, maintainers should be able to run a quick smoke test that verifies the public app and API are reachable.

Acceptance Criteria

Add a script that checks frontend URL, backend health, yield endpoint, and a simple static asset.
Support configurable URLs via environment variables.
Print clear pass/fail output.
Document when to run the smoke test after merge or deploy.
Technical Details

Location: root scripts or scripts/ directory, README or release docs.
Complexity and Scope
Estimated Time: 1-2 days.
Complexity: Low to Medium.


