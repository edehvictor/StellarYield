export interface AccountPortfolio {
  accountId: string;
  balance: number;
  vaultAllocations: Record<string, number>;
}

export class AggregationSafeguardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AggregationSafeguardError';
  }
}

/**
 * Service providing safeguards for multi-account portfolio aggregations.
 */
export class MultiAccountPortfolioAggregationSafeguards {
  private readonly MAX_ACCOUNTS_ALLOWED = 50;
  private readonly MAX_TOTAL_BALANCE = 1_000_000_000; // $1B safeguard

  /**
   * Validates the portfolios before allowing aggregation to prevent DoS or logic overflow.
   */
  public validateForAggregation(portfolios: AccountPortfolio[]): void {
    if (!portfolios || portfolios.length === 0) {
      throw new AggregationSafeguardError('Cannot aggregate an empty portfolio list');
    }

    if (portfolios.length > this.MAX_ACCOUNTS_ALLOWED) {
      throw new AggregationSafeguardError(`Aggregation exceeded maximum allowed accounts: ${this.MAX_ACCOUNTS_ALLOWED}`);
    }

    const totalBalance = portfolios.reduce((sum, p) => sum + p.balance, 0);
    if (totalBalance > this.MAX_TOTAL_BALANCE) {
      throw new AggregationSafeguardError('Aggregation exceeded maximum safe total balance capacity');
    }

    // Ensure no duplicate accounts
    const accountIds = new Set(portfolios.map(p => p.accountId));
    if (accountIds.size !== portfolios.length) {
      throw new AggregationSafeguardError('Duplicate accounts detected in aggregation request');
    }
  }
}
