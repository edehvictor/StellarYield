> ⚠️ **NOTICE FOR DRIPS WAVE REVIEWERS:** > The original Vercel domain submitted in the application (`stellar-yield.vercel.app`) was claimed by a squatter during the final build process. 
> 
> **👉 THE OFFICIAL LIVE APPLICATION IS HERE: https://stellaryield.vercel.app**
# 🌟 StellarYield: AI-Powered DeFi Aggregator & Auto-Vault

![Stellar](https://img.shields.io/badge/Stellar-Blockchain-black?style=for-the-badge&logo=stellar)
![React](https://img.shields.io/badge/React-Vite-blue?style=for-the-badge&logo=react)
![Node.js](https://img.shields.io/badge/Node.js-Express-green?style=for-the-badge&logo=nodedotjs)
![Soroban](https://img.shields.io/badge/Soroban-Smart_Contracts-orange?style=for-the-badge&logo=rust)
![Drips Wave](https://img.shields.io/badge/Drips_Wave-Active-success?style=for-the-badge)

## 🧩 Project Summary
**StellarYield** is a unified DeFi dashboard and automated yield-routing system built on the Stellar network. It aggregates real-time APY rates from across the ecosystem, uses an AI layer to analyze risk, and leverages Soroban smart contracts to automatically rebalance user funds into the highest-paying liquidity pools.

**Key Benefits:**
* ⚡ **One-Click Rebalancing:** Move funds between protocols via Soroban smart contracts.
* 🧠 **AI Risk Assessment:** Claude-powered recommendations based on your personal risk tolerance.
* 🔍 **Unified Dashboard:** Compare Blend, Soroswap, and DeFindex APYs side-by-side.
* 💰 **Optimized Returns:** Never miss a yield spike; the auto-vault does the heavy lifting.

---

## 🚨 Problem This Solves
The Stellar DeFi ecosystem is expanding, but liquidity opportunities are highly fragmented.

| Problem | Impact |
| :--- | :--- |
| **Scattered Liquidity** | Users must manually visit 5+ different dApps daily to compare current APY rates. |
| **Manual Rebalancing** | Users lose potential yield while away from their screens or miss sudden APY spikes. |
| **Risk Complexity** | High APY percentages often mask low liquidity, impermanent loss, or protocol risks. |
| **Friction & Time** | Manually withdrawing and redepositing across protocols requires multiple transactions. |

---

## 💡 Core Concept
Instead of users manually hunting for yield, StellarYield acts as a centralized command center. Users connect their Freighter wallet, consult the AI Advisor for a personalized strategy, and deposit funds into a Soroban Vault that automatically routes capital to the best-performing Stellar protocols.

### 🏗 System Architecture

```text
┌─────────────────┐      ┌──────────────┐      ┌─────────────────┐
│  User / Wallet  │      │   Backend    │      │  Stellar DeFi   │
│  (Freighter)    │────▶ │  (API/Node)  │────▶ │  (Blend, etc.)  │
└─────────────────┘      └──────────────┘      └─────────────────┘
         │                       │                      ▲
         ▼                       ▼                      │
┌─────────────────┐      ┌──────────────┐      ┌─────────────────┐
│   AI Advisor    │      │ Yield Engine │      │  Soroban Vault  │
│  (Claude API)   │      │ (PostgreSQL) │      │ (Smart Contract)│
└─────────────────┘      └──────────────┘      └─────────────────┘
         │                                              ▲
         └──────────────────────────────────────────────┘

🔑 Main Actors
| Actor | Role |
|---|---|
| Depositor (User) | Connects wallet, sets risk tolerance, and deposits XLM/USDC. |
| AI Advisor | Analyzes real-time TVL/APY data and recommends allocation strategies. |
| Backend Engine | Fetches and caches APY data every 15 minutes to prevent API rate-limiting. |
| Soroban Vault | Smart contract holding user deposits; executes the routing logic to dApps. |
⚙️ Core Features
1️⃣ Aggregator Dashboard
 * Real-time Metrics: Live APY, TVL, and Asset tracking.
 * Historical Charts: Recharts-powered graphs showing 30-day yield trends.
 * Glassmorphism UI: Premium dark-mode aesthetic built with Tailwind CSS.
2️⃣ AI Risk Portal
 * Personalized Strategy: Select Conservative, Balanced, or Degen risk levels.
 * Contextual Explanations: AI explains why a protocol is recommended (e.g., noting low TVL risks).
 * Yield Projections: Estimated 30/90/365-day returns.
3️⃣ Auto-Yield Vaults (Soroban)
 * Smart Routing: Deposits are automatically routed to the highest-paying, risk-adjusted protocol.
 * Emergency Withdraw: Users retain custody and can pull funds back to their wallet at any time.
🛠 Tech Stack
Frontend (/client)
 * React + Vite: Modern, fast build tooling.
 * Tailwind CSS + shadcn/ui: Styling and component library.
 * Recharts: APY trend visualization.
 * Stellar Freighter API: Wallet connection.
Backend (/server)
 * Node.js + Express: API framework and scheduling.
 * Anthropic Claude API: AI yield recommendation logic.
 * PostgreSQL: (Planned) Caching APY history and user preferences.
Blockchain (/contracts)
 * Rust & Soroban: Smart contract environment.
 * Stellar SDK: Interacting with the Horizon network.
🚀 Getting Started
Prerequisites
 * Node.js v18+
 * Rust & Soroban CLI
 * Freighter Wallet Browser Extension
Installation & Setup
 * Clone the repository:
   git clone [https://github.com/YOUR_GITHUB_NAME/StellarYield.git](https://github.com/YOUR_GITHUB_NAME/StellarYield.git)
cd StellarYield

 * Frontend Setup:
   cd client
npm install
npm run dev

   The dashboard will be available at http://localhost:5173
 * Backend Setup:
   cd ../server
npm install
npm run dev

   The mock API will be available at http://localhost:3001
🌊 Contributing via Drips Wave
We are proudly participating in the Stellar Wave Program via Drips! We are actively looking for Web3 full-stack and Rust developers.
Check our open issues labeled Stellar Wave, apply via the Drips App, and submit your PR to earn rewards funded by the Stellar Development Foundation!

Would you like me to walk you through how to connect this finished repository to the Drips Wave App so you can start adding those issues?

---

## ✅ Post-deploy smoke test

After merge/deploy, you can quickly verify the public app + API are reachable:

```bash
npm run smoke-test
```

### Configuration

Override targets via environment variables:

```bash
FRONTEND_URL="https://stellaryield.vercel.app" \
BACKEND_URL="https://your-backend.example.com" \
npm run smoke-test
```

Optional path overrides:

- `BACKEND_HEALTH_PATH` (default: `/api/health`)
- `BACKEND_YIELDS_PATH` (default: `/api/yields`)
- `FRONTEND_ASSET_PATH` (default: `/favicon.ico`)

