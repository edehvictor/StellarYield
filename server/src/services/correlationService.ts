import { PROTOCOLS } from "../config/protocols";

export interface CorrelationMatrix {
  items: string[];
  matrix: number[][];
  warnings: string[];
}

/**
 * Calculates the Pearson correlation coefficient between two arrays.
 */
export function calculatePearsonCorrelation(x: number[], y: number[], expectedWindowSize: number): number {
  if (x.length !== expectedWindowSize || y.length !== expectedWindowSize) {
    throw new Error(`Incomplete data window. Expected ${expectedWindowSize}, got x:${x.length}, y:${y.length}`);
  }

  const n = expectedWindowSize;
  if (n === 0) return 0;

  const meanX = x.reduce((a, b) => a + b, 0) / n;
  const meanY = y.reduce((a, b) => a + b, 0) / n;

  let sumNumerator = 0;
  let sumDenominatorX = 0;
  let sumDenominatorY = 0;

  for (let i = 0; i < n; i++) {
    const dx = x[i] - meanX;
    const dy = y[i] - meanY;
    sumNumerator += dx * dy;
    sumDenominatorX += dx * dx;
    sumDenominatorY += dy * dy;
  }

  if (sumDenominatorX === 0 || sumDenominatorY === 0) return 0;
  return sumNumerator / Math.sqrt(sumDenominatorX * sumDenominatorY);
}

/**
 * Generates mock time-series data for a given set of protocols.
 */
function generateMockTimeseries(protocols: string[], windowSize: number): Record<string, number[]> {
  const timeseries: Record<string, number[]> = {};

  // For demonstration, we create correlated data by using a shared random walk
  // and adding some specific noises.
  const sharedFactor = Array.from({ length: windowSize }, () => Math.random());

  protocols.forEach((protocol, index) => {
    timeseries[protocol] = [];
    let base = 5 + index; // Starting value
    for (let i = 0; i < windowSize; i++) {
      // Protocol 0 and 1 will be highly correlated
      if (index === 0 || index === 1) {
        timeseries[protocol].push(base + sharedFactor[i] * 5 + Math.random() * 0.5);
      } else {
        // Others are mostly random independent
        timeseries[protocol].push(base + Math.random() * 5);
      }
    }
  });

  return timeseries;
}

export class CorrelationService {
  /**
   * Retrieves a pairwise correlation matrix for top protocols.
   * Checks for incomplete data windows and surface concentration warnings.
   */
  public static async getCorrelationMatrix(windowDays: number = 30, concentrationThreshold: number = 0.70): Promise<CorrelationMatrix> {
    const items = ["Blend", "Soroswap", "DeFindex", "Stellar Staking", "Protocol X"];
    
    let timeseries: Record<string, number[]>;
    try {
      timeseries = generateMockTimeseries(items, windowDays);
    } catch (e) {
      throw new Error("Failed to fetch timeseries data.");
    }

    const n = items.length;
    const matrix = Array.from({ length: n }, () => new Array(n).fill(0));
    const warnings: string[] = [];
    const highCorrelationPairs = new Set<string>();

    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        if (i === j) {
          matrix[i][j] = 1.0;
        } else {
          try {
            const correlation = calculatePearsonCorrelation(timeseries[items[i]], timeseries[items[j]], windowDays);
            matrix[i][j] = correlation;
            
            // Add concentration warning if highly correlated. 
            // We only need to check once per pair (i < j works well)
            if (i < j && Math.abs(correlation) >= concentrationThreshold) {
              warnings.push(`High correlation detected between ${items[i]} and ${items[j]} (${(correlation * 100).toFixed(1)}%). Diversification recommended.`);
            }
          } catch (error) {
            console.error(`Error calculating correlation for ${items[i]} and ${items[j]}:`, error);
            // Fail safely on incomplete windows
            matrix[i][j] = 0;
            warnings.push(`Data window incomplete for ${items[i]} or ${items[j]}. Correlation could not be calculated.`);
          }
        }
      }
    }

    return {
      items,
      matrix,
      warnings
    };
  }
}
