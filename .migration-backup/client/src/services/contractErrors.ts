export interface ContractErrorDefinition {
  title: string;
  description: string;
  actionable: boolean;
}

export const CONTRACT_ERROR_MAP: Record<string, ContractErrorDefinition> = {
  INSUFFICIENT_BALANCE: {
    title: "Insufficient Balance",
    description: "Your wallet does not have enough tokens for this transaction.",
    actionable: true,
  },
  SLIPPAGE_EXCEEDED: {
    title: "Slippage Exceeded",
    description:
      "The swap price moved beyond your slippage tolerance. Try increasing slippage or retry.",
    actionable: true,
  },
  VAULT_PAUSED: {
    title: "Vault Paused",
    description:
      "This vault is temporarily paused by the protocol. Please try again later.",
    actionable: false,
  },
  MINIMUM_DEPOSIT_NOT_MET: {
    title: "Minimum Deposit Not Met",
    description:
      "Your deposit amount is below the vault's minimum. Increase your amount and retry.",
    actionable: true,
  },
  WITHDRAWAL_LOCKED: {
    title: "Withdrawal Locked",
    description:
      "Withdrawals are locked for this vault during the current epoch.",
    actionable: false,
  },
  UNAUTHORIZED: {
    title: "Unauthorized",
    description:
      "Your wallet is not authorized to perform this action.",
    actionable: false,
  },
  CONTRACT_OVERFLOW: {
    title: "Arithmetic Overflow",
    description:
      "A calculation exceeded safe bounds. This is an unexpected contract error.",
    actionable: false,
  },
  STALE_PRICE_FEED: {
    title: "Stale Price Feed",
    description:
      "The oracle price data is outdated. The transaction was rejected to protect you from bad rates.",
    actionable: false,
  },
  EPOCH_NOT_SETTLED: {
    title: "Epoch Not Settled",
    description:
      "The previous epoch has not been settled yet. Please wait before attempting this action.",
    actionable: false,
  },
  DUPLICATE_DEPOSIT: {
    title: "Duplicate Deposit",
    description:
      "A deposit with this nonce already exists. Refresh and try again.",
    actionable: true,
  },
};

const UNKNOWN_ERROR: ContractErrorDefinition = {
  title: "Transaction Failed",
  description:
    "An unexpected error occurred. Please try again or contact support if the problem persists.",
  actionable: true,
};

export function resolveContractError(errorCode: string): ContractErrorDefinition {
  return CONTRACT_ERROR_MAP[errorCode] ?? UNKNOWN_ERROR;
}

export function isKnownError(errorCode: string): boolean {
  return Object.prototype.hasOwnProperty.call(CONTRACT_ERROR_MAP, errorCode);
}

export const UNKNOWN_ERROR_DEFINITION = UNKNOWN_ERROR;
