/**
 * Predictive APY Trend Modeling Service
 *
 * Uses exponential moving average (EMA) and linear regression to predict
 * the next 7 days of yield based on historical APY data.
 *
 * Algorithm:
 *   1. Smooth historical data with EMA to reduce noise
 *   2. Fit a linear regression on recent smoothed data to capture trend
 *   3. Project the trend forward for 7 days
 *   4. Clamp predictions to [0, historical_max * 1.5] for sanity
 *
 * This is a lightweight statistical approach that runs in Node.js without
 * external ML dependencies. For production, consider ARIMA or Prophet.
 */

// ── Types ────────────────────────────────────────────────────────────────────

export interface HistoricalDataPoint {
  date: string; // ISO date string
  apy: number; // APY as percentage (e.g. 5.2 = 5.2%)
  tvl?: number; // Optional TVL for context
}

export interface PredictionPoint {
  date: string;
  predictedApy: number;
  confidence: number; // 0-1, decreases further into the future
}

export interface ApyPrediction {
  protocol: string;
  historical: HistoricalDataPoint[];
  predictions: PredictionPoint[];
  trend: "rising" | "falling" | "stable";
  generatedAt: string;
}

// ── EMA Smoothing ────────────────────────────────────────────────────────────

/**
 * Compute Exponential Moving Average to smooth noisy APY data.
 * @param data - Raw data points
 * @param span - Number of periods for smoothing (default 7)
 */
export function ema(data: number[], span: number = 7): number[] {
  if (data.length === 0) return [];
  const alpha = 2 / (span + 1);
  const result: number[] = [data[0]];

  for (let i = 1; i < data.length; i++) {
    result.push(alpha * data[i] + (1 - alpha) * result[i - 1]);
  }

  return result;
}

// ── Linear Regression ────────────────────────────────────────────────────────

/**
 * Simple linear regression: y = slope * x + intercept
 * Returns { slope, intercept, r2 } where r2 is the coefficient of determination.
 */
export function linearRegression(values: number[]): {
  slope: number;
  intercept: number;
  r2: number;
} {
  const n = values.length;
  if (n < 2) return { slope: 0, intercept: values[0] ?? 0, r2: 0 };

  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumX2 = 0;
  let sumY2 = 0;

  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += values[i];
    sumXY += i * values[i];
    sumX2 += i * i;
    sumY2 += values[i] * values[i];
  }

  const denom = n * sumX2 - sumX * sumX;
  if (denom === 0) return { slope: 0, intercept: sumY / n, r2: 0 };

  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;

  // R-squared
  const meanY = sumY / n;
  const ssTot = sumY2 - n * meanY * meanY;
  const ssRes = values.reduce((sum, y, i) => {
    const pred = slope * i + intercept;
    return sum + (y - pred) ** 2;
  }, 0);
  const r2 = ssTot === 0 ? 0 : 1 - ssRes / ssTot;

  return { slope, intercept, r2 };
}

// ── Prediction Engine ────────────────────────────────────────────────────────

/**
 * Predict the next 7 days of APY for a protocol.
 *
 * @param protocol - Protocol name
 * @param historical - At least 7 days of historical APY data
 * @param forecastDays - Number of days to predict (default 7)
 */
export function predictApy(
  protocol: string,
  historical: HistoricalDataPoint[],
  forecastDays: number = 7,
): ApyPrediction {
  if (historical.length < 3) {
    // Not enough data; return flat projection from last known value
    const lastApy = historical[historical.length - 1]?.apy ?? 0;
    return {
      protocol,
      historical,
      predictions: generateFlatPredictions(lastApy, forecastDays),
      trend: "stable",
      generatedAt: new Date().toISOString(),
    };
  }

  const rawValues = historical.map((d) => d.apy);
  const historicalMax = Math.max(...rawValues);

  // Step 1: Smooth with EMA
  const smoothed = ema(rawValues, Math.min(7, Math.floor(rawValues.length / 2)));

  // Step 2: Linear regression on recent smoothed data (last 14 points or all)
  const recentWindow = smoothed.slice(-Math.min(14, smoothed.length));
  const { slope, intercept, r2 } = linearRegression(recentWindow);

  // Step 3: Project forward
  const lastIndex = recentWindow.length - 1;
  const lastDate = new Date(historical[historical.length - 1].date);
  const maxAllowed = Math.max(historicalMax * 1.5, 0.1);

  const predictions: PredictionPoint[] = [];
  for (let day = 1; day <= forecastDays; day++) {
    const projectedIndex = lastIndex + day;
    let predictedApy = slope * projectedIndex + intercept;

    // Clamp to reasonable bounds
    predictedApy = Math.max(0, Math.min(predictedApy, maxAllowed));

    const futureDate = new Date(lastDate);
    futureDate.setDate(futureDate.getDate() + day);

    // Confidence decreases with distance from known data
    const confidence = Math.max(0.1, Math.min(1, r2 * (1 - day / (forecastDays * 2))));

    predictions.push({
      date: futureDate.toISOString().split("T")[0],
      predictedApy: Math.round(predictedApy * 100) / 100,
      confidence: Math.round(confidence * 100) / 100,
    });
  }

  // Determine trend from slope
  const trend: "rising" | "falling" | "stable" =
    slope > 0.05 ? "rising" : slope < -0.05 ? "falling" : "stable";

  return {
    protocol,
    historical,
    predictions,
    trend,
    generatedAt: new Date().toISOString(),
  };
}

function generateFlatPredictions(apy: number, days: number): PredictionPoint[] {
  const predictions: PredictionPoint[] = [];
  const now = new Date();
  for (let day = 1; day <= days; day++) {
    const d = new Date(now);
    d.setDate(d.getDate() + day);
    predictions.push({
      date: d.toISOString().split("T")[0],
      predictedApy: apy,
      confidence: 0.3,
    });
  }
  return predictions;
}
