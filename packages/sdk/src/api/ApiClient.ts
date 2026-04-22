import type { ApiConfig, ApiVaultData, HistoricalDataPoint } from "../types";

/**
 * ApiClient provides methods to interact with the StellarYield backend API.
 * 
 * @remarks
 * This client fetches vault metrics, APY data, and historical performance
 * from the StellarYield backend service.
 * 
 * @example
 * ```typescript
 * import { ApiClient } from '@stellaryield/sdk';
 * 
 * const api = new ApiClient({
 *   baseUrl: 'https://api.stellaryield.io'
 * });
 * 
 * const apy = await api.getCurrentAPY('vault-123');
 * const history = await api.getHistoricalData('vault-123', 30);
 * ```
 */
export class ApiClient {
  private config: ApiConfig;

  constructor(config: ApiConfig) {
    this.config = config;
  }

  /**
   * Get current APY for a vault.
   * 
   * @param vaultId - The vault contract ID
   * @returns Current APY as a percentage
   */
  async getCurrentAPY(vaultId: string): Promise<number> {
    const response = await fetch(`${this.config.baseUrl}/api/vaults/${vaultId}/apy`);
    
    if (!response.ok) {
      throw new Error(`Failed to fetch APY: ${response.statusText}`);
    }
    
    const data = await response.json() as { apy: number };
    return data.apy;
  }

  /**
   * Get historical APY and TVL data for a vault.
   * 
   * @param vaultId - The vault contract ID
   * @param days - Number of days of history to retrieve
   * @returns Array of historical data points
   */
  async getHistoricalData(vaultId: string, days: number = 30): Promise<HistoricalDataPoint[]> {
    const response = await fetch(
      `${this.config.baseUrl}/api/vaults/${vaultId}/history?days=${days}`
    );
    
    if (!response.ok) {
      throw new Error(`Failed to fetch historical data: ${response.statusText}`);
    }
    
    const data = await response.json() as { data: HistoricalDataPoint[] };
    return data.data;
  }

  /**
   * Get comprehensive vault data including APY, TVL, and history.
   * 
   * @param vaultId - The vault contract ID
   * @returns Complete vault data object
   */
  async getVaultData(vaultId: string): Promise<ApiVaultData> {
    const [apy, historicalData] = await Promise.all([
      this.getCurrentAPY(vaultId),
      this.getHistoricalData(vaultId, 30),
    ]);

    const latest = historicalData[historicalData.length - 1];
    
    return {
      apy,
      tvl: latest?.tvl ?? 0,
      historicalData,
    };
  }

  /**
   * Get current TVL for a vault.
   * 
   * @param vaultId - The vault contract ID
   * @returns Total Value Locked in USD
   */
  async getTVL(vaultId: string): Promise<number> {
    const response = await fetch(`${this.config.baseUrl}/api/vaults/${vaultId}/tvl`);
    
    if (!response.ok) {
      throw new Error(`Failed to fetch TVL: ${response.statusText}`);
    }
    
    const data = await response.json() as { tvl: number };
    return data.tvl;
  }
}
