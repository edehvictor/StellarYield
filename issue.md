#88 Delta-Neutral Basis Trading Strategy Contract
Repo Avatar
edehvictor/StellarYield
📝 Description
We need an automated strategy that generates yield regardless of market direction by executing a delta-neutral basis trade (going long on spot and short on perpetuals to collect funding rates).

🎯 Acceptance Criteria
 Write a strategy contract that splits a USDC deposit.
 Uses half to buy an asset on the AMM (Spot Long).
 Uses half to open a 1x Short position on the Perpetuals exchange.
 Implements an auto_rebalance function to maintain the delta-neutral peg when prices move.
🛠 Technical Details
Stack: Rust, Soroban Cross-Contract Calls.
Location: /contracts/strategies/delta_neutral.rs
Security: Highly susceptible to slippage and impermanent loss during the rebalance phase.
⏱ Complexity & Scope
Estimated Time: 3-4 weeks.
Drips Complexity: High (200 points) - Wall Street-level financial engineering.
📋 Guidelines for Submission
Minimum 90 percent test coverage required.
Clear NatSpec-style documentation must be added to public contract functions.
Timeframe for completion: 2 Wave cycles.

#101 Interactive Web3 Quest & Achievement Engine (Frontend)
Repo Avatar
edehvictor/StellarYield
📝 Description
To drive user engagement and protocol TVL, we need an on-chain "Quest" system (similar to Galxe or Layer3) built directly into our UI.

🎯 Acceptance Criteria
 Build a React dashboard tracking user actions (e.g., "Deposit 100 USDC", "Hold for 30 Days").
 The frontend must query the indexer to verify completion of on-chain objectives.
 Upon completion, allow the user to trigger a Soroban contract call to mint an exclusive "Achievement Badge" NFT.
 Build celebratory animations using Framer Motion when badges are unlocked.
🛠 Technical Details
Stack: React, Framer Motion, Soroban SDK.
Location: /frontend/src/pages/quests/
Security: Ensure the indexer validation cannot be spoofed by client-side tampering.
⏱ Complexity & Scope
Estimated Time: 3-4 weeks.
Drips Complexity: High (200 points) - Full-stack feature involving UI, indexer, and smart contracts.
📋 Guidelines for Submission
Minimum 90 percent test coverage required.
Clear NatSpec-style documentation must be added to public contract functions.
Timeframe for completion: 2 Wave cycles.



#78 WebGL 3D Portfolio Visualizer (Frontend)
Repo Avatar
edehvictor/StellarYield
📝 Description
Gamify the DeFi experience by replacing boring line charts with a WebGL interactive 3D universe mapping a user's liquidity positions and yield flows.

🎯 Acceptance Criteria
 Integrate Three.js or @react-three/fiber into the React frontend.
 Render liquidity pools as nodes, with sizes representing TVL and emission flows animated as particle streams.
 Map the user's active deposits visually within this environment.
 Ensure rendering is optimized for 60FPS on mid-tier mobile devices.
🛠 Technical Details
Stack: React, Three.js, WebGL.
Location: /frontend/src/components/visualizer/
Security: N/A. Focus is heavily on GPU optimization and memory management.
⏱ Complexity & Scope
Estimated Time: 2-3 weeks.
Drips Complexity: High (200 points) - Highly specialized frontend graphics rendering.
📋 Guidelines for Submission
Minimum 90 percent test coverage required.
Clear NatSpec-style documentation must be added to public contract functions.
Timeframe for completion: 2 Wave cycles.

#95 Real-Time Mempool Transaction Visualizer (Frontend)
Repo Avatar
edehvictor/StellarYield
📝 Description
Users want to see network activity visually before they submit a trade. We need a frontend dashboard that connects to a stellar-core node and visualizes the mempool in real-time.

🎯 Acceptance Criteria
 Integrate a WebSocket connection to a Stellar node to stream pending transactions.
 Use D3.js or React Flow to visualize pending transactions as floating nodes, clustering them by interacting smart contract.
 Visually differentiate standard transfers from complex DeFi vault interactions.
🛠 Technical Details
Stack: React, D3.js, WebSockets.
Location: /frontend/src/components/mempool_graph/
Security: Handle WebSocket disconnects and high-volume data streams without crashing the browser.
⏱ Complexity & Scope
Estimated Time: 3 weeks.
Drips Complexity: High (200 points) - Advanced data visualization and state management.
📋 Guidelines for Submission
Minimum 90 percent test coverage required.
Clear NatSpec-style documentation must be added to public contract functions.
Timeframe for completion: 2 Wave cycles.
