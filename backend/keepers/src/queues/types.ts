/**
 * Shared job-name constants used by producers (monitors) and consumers (workers).
 * Using typed constants reduces typo errors across queue interactions.
 */
export const QUEUE_NAMES = {
  LIQUIDATION: 'liquidation',
  COMPOUND: 'compound',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

/** Payload for a liquidation job */
export interface LiquidationJobData {
  /** Stellar address of the undercollateralized account */
  accountAddress: string;
  /** Current CR in basis points (at time of scan) */
  currentCrBps: number;
  /** Collateral value in USD (7 decimal precision) */
  collateralValueUsd: string;
  /** Outstanding debt in sUSD */
  debtAmount: string;
}

/** Payload for an auto-compound job */
export interface CompoundJobData {
  /** Vault contract ID to compound */
  vaultContractId: string;
  /** Expected minimum harvest amount (slippage guard) */
  minHarvestAmount: string;
}
