# Fee Assumptions & Yield Modeling Guide

This document outlines the standard types of fees and assumptions modeled within the Stellar Yield platform (including net yield calculations, treasury simulations, and exit impact estimates).

---

## 1. Core Fee Types

We factor the following fee categories into our calculations and simulators to show realistic net yield outcomes:

### A. Management Fees
* **What they are**: Vault-specific fees charged by automated yield strategies or fund managers.
* **How they impact you**: Usually deducted dynamically from the strategy’s earnings to cover the gas/operational cost of continuous portfolio rebalancing.

### B. Protocol/Liquidity Pool Fees
* **What they are**: Fees charged by the underlying smart contracts (such as Soroswap swap fees or Blend lending pool rates).
* **How they impact you**: Charged during swap, entry, or interest collection phases. Typically, these are built into the pool’s dynamic APY or subtracted from swap payouts.

### C. Network (Stellar Network) Fees
* **What they are**: Small transactional fees (gas) required to write transactions to the Stellar blockchain.
* **How they impact you**: Very low on the Stellar network (typically a fraction of a cent), but modeled for precision in multi-step rebalancing operations.

### D. Slippage & Price Impact (Execution Drag)
* **What they are**: The price difference caused by withdrawing or swapping a significant portion of an asset against a pool's limited liquidity.
* **How they impact you**: High-volume transactions push the price unfavorably, reducing the actual amount of funds received during exit.

### E. Rotation / Exit Costs
* **What they are**: One-time expenses (including protocol exit fees, pool withdrawal fees, and asset conversion swap fees) incurred when removing capital from a strategy.
* **How they impact you**: Can drag down net yield if you rotate portfolios frequently.

---

## 2. Key Modeling Assumptions

* **Decay and Static Projections**: APYs are annualized projections based on recent historical performance and pool activity. Real-time rates fluctuate continuously.
* **Constant Product Slippage**: Exit impact estimates use standard Constant Product (x * y = k) mathematical models to approximate price slippage.
* **Linear Cost Distribution**: Routine rebalancing costs are amortized linearly over time.

---

## 3. Important Disclaimer

> [!WARNING]
> **No Guaranteed Outcomes**
> All calculations, projections, and simulation outcomes presented on this platform are dynamic estimates based on historical data and mathematical models.
> 
> Actual fees, slippage, and net yield outcomes will fluctuate in real-time based on live blockchain congestion, dynamic pool liquidity, custom vault adjustments, and exact transactional execution timing. We do not guarantee or promise any specific financial yields or exact fee outcomes.
