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
  void req;
  res.json(mockYields);
});

app.post('/api/recommend', (req: Request, res: Response) => {
  const { preferences, riskTolerance } = req.body;
  void preferences;
  // Mock Claude AI recommendation based on inputs
  res.json({
    recommendation: `Based on your ${riskTolerance || 'moderate'} risk tolerance, we recommend the Yield Index vault on DeFindex for diversified, stable returns.`,
    targetVault: 'DeFindex Yield Index',
    expectedApy: 8.9
  });
});

app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
