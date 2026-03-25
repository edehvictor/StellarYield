import express, { Request, Response } from 'express';
import cors from 'cors';

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// Mock Data for Vaults
const mockYields = [
  { protocol: 'Blend', asset: 'USDC', apy: 6.5, tvl: 12000000, risk: 'Low' },
  { protocol: 'Soroswap', asset: 'XLM-USDC', apy: 12.2, tvl: 4500000, risk: 'Medium' },
  { protocol: 'DeFindex', asset: 'Yield Index', apy: 8.9, tvl: 8000000, risk: 'Medium' },
  { protocol: 'Blend', asset: 'XLM', apy: 4.2, tvl: 25000000, risk: 'Low' },
  { protocol: 'Soroswap', asset: 'AQUA-USDC', apy: 18.5, tvl: 1200000, risk: 'High' }
];

app.get('/api/yields', (req: Request, res: Response) => {
  res.json(mockYields);
});

app.post('/api/recommend', (req: Request, res: Response) => {
  const { preferences, riskTolerance } = req.body;
  // Mock Claude AI recommendation based on inputs
  res.json({
    recommendation: `Based on your ${riskTolerance || 'moderate'} risk tolerance, we recommend the Yield Index vault on DeFindex for diversified, stable returns.`,
    targetVault: 'DeFindex Yield Index',
    expectedApy: 8.9
  });
});

// Predictive APY endpoint
import { predictApy, HistoricalDataPoint } from './analytics/apyPredictor';

app.get('/api/yields/predict', (req: Request, res: Response) => {
  const protocol = (req.query.protocol as string) || 'Blend';

  // Generate mock historical data (last 30 days) based on the protocol's current APY
  const vault = mockYields.find((v) => v.protocol === protocol);
  const baseApy = vault?.apy ?? 5;

  const historical: HistoricalDataPoint[] = [];
  const now = new Date();
  for (let i = 29; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    // Add realistic noise around the base APY
    const noise = (Math.random() - 0.5) * baseApy * 0.2;
    historical.push({
      date: d.toISOString().split('T')[0],
      apy: Math.round((baseApy + noise) * 100) / 100,
      tvl: vault?.tvl,
    });
  }

  const prediction = predictApy(protocol, historical);
  res.json(prediction);
});

app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
