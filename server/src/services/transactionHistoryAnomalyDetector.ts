export interface Transaction {
  id: string;
  amount: number;
  timestamp: Date;
  type: 'deposit' | 'withdrawal' | 'transfer';
}

export interface Anomaly {
  transactionId: string;
  reason: string;
  severity: 'low' | 'medium' | 'high';
}

/**
 * Service to detect anomalies in transaction histories.
 */
export class TransactionHistoryAnomalyDetector {
  /**
   * Detects anomalies in a list of transactions based on volume, frequency, and pattern.
   */
  public detectAnomalies(transactions: Transaction[]): Anomaly[] {
    const anomalies: Anomaly[] = [];
    const sortedTxs = [...transactions].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

    for (let i = 0; i < sortedTxs.length; i++) {
      const tx = sortedTxs[i];
      
      // Edge case 1: Unusually large transaction
      if (tx.amount > 1_000_000) {
        anomalies.push({
          transactionId: tx.id,
          reason: 'Unusually large transaction amount detected',
          severity: 'high'
        });
      }

      // Edge case 2: Rapid consecutive transactions
      if (i > 0) {
        const prevTx = sortedTxs[i - 1];
        const timeDiffMs = tx.timestamp.getTime() - prevTx.timestamp.getTime();
        if (timeDiffMs < 5000 && tx.type === prevTx.type) { // Less than 5 seconds apart
          anomalies.push({
            transactionId: tx.id,
            reason: 'High frequency of identical transaction types',
            severity: 'medium'
          });
        }
      }
    }

    return anomalies;
  }
}
