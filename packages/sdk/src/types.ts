export interface VaultConfig {
  contractId: string;
  networkPassphrase: string;
  rpcUrl: string;
}

export interface ApiConfig {
  baseUrl: string;
}

export interface DepositParams {
  from: string;
  amount: string;
  minSharesOut?: string;
}

export interface WithdrawParams {
  to: string;
  shares: string;
}

export interface VaultInfo {
  totalShares: string;
  totalAssets: string;
  token: string;
  admin: string;
}

export interface ApiVaultData {
  apy: number;
  tvl: number;
  historicalData: HistoricalDataPoint[];
}

export interface HistoricalDataPoint {
  timestamp: string;
  apy: number;
  tvl: number;
}

export interface SDKConfig {
  vault: VaultConfig;
  api?: ApiConfig;
}
