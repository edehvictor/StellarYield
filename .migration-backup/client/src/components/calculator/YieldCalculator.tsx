import { useState, useMemo } from 'react';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from 'recharts';
import {
  Calculator,
  TrendingUp,
  DollarSign,
  Calendar,
  Percent,
  Info,
} from 'lucide-react';
import type { CompoundConfig } from './compoundMath';
import {
  calculateCompoundProjection,
  calculateProjectionMetrics,
  formatCurrency,
  formatPercentage,
  validateConfig,
} from './compoundMath';

interface TooltipPayloadEntry {
  payload: {
    label: string;
    compound: number;
    simple: number;
    principal: number;
  };
}

interface CustomTooltipProps {
  active?: boolean;
  payload?: TooltipPayloadEntry[];
}

function CustomTooltip({ active, payload }: CustomTooltipProps) {
  if (active && payload && payload.length) {
    const data = payload[0].payload;
    return (
      <div className="bg-slate-900 border border-slate-700 rounded-lg p-4 shadow-xl">
        <p className="text-white font-semibold mb-2">{data.label}</p>
        <div className="space-y-1 text-sm">
          <p className="text-green-400">
            Yield Farming: {formatCurrency(data.compound)}
          </p>
          <p className="text-blue-400">
            Simple Interest: {formatCurrency(data.simple)}
          </p>
          <p className="text-gray-400">
            Principal Only: {formatCurrency(data.principal)}
          </p>
        </div>
      </div>
    );
  }
  return null;
}

function timeframeForYears(years: number): '1' | '5' | '10' {
  if (years >= 10) return '10';
  if (years >= 5) return '5';
  return '1';
}

export default function YieldCalculator() {
  const [principal, setPrincipal] = useState(10000);
  const [monthlyContribution, setMonthlyContribution] = useState(500);
  const [apy, setApy] = useState(8.5);
  const [years, setYears] = useState(5);
  const [showTooltip, setShowTooltip] = useState(false);
  const [selectedTimeframe, setSelectedTimeframe] = useState<'1' | '5' | '10'>('5');

  const config: CompoundConfig = useMemo(() => ({
    principal,
    monthlyContribution,
    apy,
    years,
  }), [principal, monthlyContribution, apy, years]);

  const errors = useMemo(() => validateConfig(config), [config]);

  const projections = useMemo(() => {
    if (errors.length > 0) return [];
    return calculateCompoundProjection(config);
  }, [config, errors]);

  const metrics = useMemo(() => {
    if (projections.length === 0) {
      return {
        finalValue: 0,
        totalContributions: 0,
        totalInterest: 0,
        totalReturnPercent: 0,
        annualizedReturn: 0,
      };
    }
    return calculateProjectionMetrics(projections);
  }, [projections]);

  const filteredProjections = useMemo(() => {
    const maxMonths = parseInt(selectedTimeframe) * 12;
    return projections.filter(p => p.period <= maxMonths);
  }, [projections, selectedTimeframe]);

  const chartData = useMemo(() => {
    return filteredProjections.map(point => ({
      month: point.period,
      year: point.year,
      label: point.period % 12 === 0 ? `Year ${point.year}` : `M${point.period % 12}`,
      compound: Math.round(point.compoundValue),
      simple: Math.round(point.simpleValue),
      principal: Math.round(point.principalOnly),
    }));
  }, [filteredProjections]);

  function handleYearsChange(e: React.ChangeEvent<HTMLInputElement>) {
    const newYears = Number(e.target.value);
    setYears(newYears);
    setSelectedTimeframe(timeframeForYears(newYears));
  }

  if (errors.length > 0) {
    return (
      <div className="glass-card p-6">
        <div className="flex items-center gap-3 text-red-400 mb-4">
          <Info size={20} />
          <span>Please correct the following errors:</span>
        </div>
        <ul className="list-disc list-inside text-red-400 space-y-1">
          {errors.map((error, index) => (
            <li key={index}>{error}</li>
          ))}
        </ul>
      </div>
    );
  }

  return (
    <div className="glass-card p-6">
      {/* Header */}
      <div className="flex items-center gap-3 mb-8">
        <Calculator className="text-indigo-400" size={28} />
        <div>
          <h2 className="text-2xl font-bold text-white">Yield Calculator</h2>
          <p className="text-gray-400">Project your wealth with compound interest</p>
        </div>
      </div>

      {/* Input Controls */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
        {/* Initial Deposit */}
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <DollarSign className="text-indigo-400" size={16} />
            <label className="text-white font-medium">Initial Deposit</label>
          </div>
          <div className="flex items-center gap-4">
            <input
              type="range"
              min="0"
              max="100000"
              step="1000"
              value={principal}
              onChange={(e) => setPrincipal(Number(e.target.value))}
              className="flex-1 h-2 bg-slate-700 rounded-lg appearance-none cursor-pointer slider"
            />
            <span className="text-white font-mono min-w-[100px] text-right">
              {formatCurrency(principal)}
            </span>
          </div>
        </div>

        {/* Monthly Contribution */}
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <TrendingUp className="text-indigo-400" size={16} />
            <label className="text-white font-medium">Monthly Addition</label>
          </div>
          <div className="flex items-center gap-4">
            <input
              type="range"
              min="0"
              max="10000"
              step="100"
              value={monthlyContribution}
              onChange={(e) => setMonthlyContribution(Number(e.target.value))}
              className="flex-1 h-2 bg-slate-700 rounded-lg appearance-none cursor-pointer slider"
            />
            <span className="text-white font-mono min-w-[100px] text-right">
              {formatCurrency(monthlyContribution)}
            </span>
          </div>
        </div>

        {/* APY */}
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Percent className="text-indigo-400" size={16} />
            <label className="text-white font-medium">Annual APY</label>
            <div
              className="relative"
              onMouseEnter={() => setShowTooltip(true)}
              onMouseLeave={() => setShowTooltip(false)}
            >
              <Info className="text-gray-400 cursor-help" size={14} />
              {showTooltip && (
                <div className="absolute bottom-full left-0 mb-2 w-48 p-2 bg-slate-800 text-xs text-gray-300 rounded shadow-lg z-10">
                  Annual Percentage Yield with daily compounding
                </div>
              )}
            </div>
          </div>
          <div className="flex items-center gap-4">
            <input
              type="range"
              min="0"
              max="30"
              step="0.1"
              value={apy}
              onChange={(e) => setApy(Number(e.target.value))}
              className="flex-1 h-2 bg-slate-700 rounded-lg appearance-none cursor-pointer slider"
            />
            <span className="text-white font-mono min-w-[60px] text-right">
              {formatPercentage(apy, 1)}
            </span>
          </div>
        </div>

        {/* Time Horizon */}
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Calendar className="text-indigo-400" size={16} />
            <label className="text-white font-medium">Time Horizon</label>
          </div>
          <div className="flex items-center gap-4">
            <input
              type="range"
              min="1"
              max="30"
              step="1"
              value={years}
              onChange={handleYearsChange}
              className="flex-1 h-2 bg-slate-700 rounded-lg appearance-none cursor-pointer slider"
            />
            <span className="text-white font-mono min-w-[60px] text-right">
              {years}y
            </span>
          </div>
        </div>
      </div>

      {/* Metrics Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
        <MetricCard
          label="Final Value"
          value={formatCurrency(metrics.finalValue)}
          color="text-green-400"
        />
        <MetricCard
          label="Total Contributed"
          value={formatCurrency(metrics.totalContributions)}
          color="text-blue-400"
        />
        <MetricCard
          label="Interest Earned"
          value={formatCurrency(metrics.totalInterest)}
          color="text-purple-400"
        />
        <MetricCard
          label="Total Return"
          value={formatPercentage(metrics.totalReturnPercent)}
          color="text-yellow-400"
        />
      </div>

      {/* Timeframe Selector */}
      <div className="flex items-center gap-4 mb-6">
        <span className="text-gray-400">Timeframe:</span>
        <div className="flex gap-2">
          {(['1', '5', '10'] as const).map((timeframe) => (
            <button
              key={timeframe}
              onClick={() => setSelectedTimeframe(timeframe)}
              className={`px-4 py-2 rounded-lg font-medium transition ${
                selectedTimeframe === timeframe
                  ? 'bg-indigo-500 text-white'
                  : 'bg-slate-700 text-gray-300 hover:bg-slate-600'
              }`}
            >
              {timeframe} Year{timeframe !== '1' ? 's' : ''}
            </button>
          ))}
        </div>
      </div>

      {/* Chart */}
      <div className="h-[400px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={chartData} margin={{ top: 10, right: 30, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id="compoundGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#10b981" stopOpacity={0.3} />
                <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
              </linearGradient>
              <linearGradient id="simpleGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.3} />
                <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
              </linearGradient>
              <linearGradient id="principalGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#6b7280" stopOpacity={0.3} />
                <stop offset="95%" stopColor="#6b7280" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
            <XAxis
              dataKey="label"
              stroke="#9ca3af"
              tick={{ fill: '#9ca3af', fontSize: 12 }}
            />
            <YAxis
              stroke="#9ca3af"
              tick={{ fill: '#9ca3af', fontSize: 12 }}
              tickFormatter={(value) => `$${(value / 1000).toFixed(0)}k`}
            />
            <Tooltip content={<CustomTooltip />} />
            <Legend />
            <Area
              type="monotone"
              dataKey="compound"
              stroke="#10b981"
              fill="url(#compoundGradient)"
              strokeWidth={2}
              name="Yield Farming"
            />
            <Area
              type="monotone"
              dataKey="simple"
              stroke="#3b82f6"
              fill="url(#simpleGradient)"
              strokeWidth={2}
              name="Simple Interest"
            />
            <Area
              type="monotone"
              dataKey="principal"
              stroke="#6b7280"
              fill="url(#principalGradient)"
              strokeWidth={2}
              name="Principal Only"
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      {/* Additional Info */}
      <div className="mt-6 p-4 bg-slate-800/50 rounded-lg">
        <div className="flex items-center gap-2 mb-2">
          <Info className="text-indigo-400" size={16} />
          <span className="text-white font-medium">Annualized Return</span>
        </div>
        <p className="text-2xl font-bold text-green-400">
          {formatPercentage(metrics.annualizedReturn)}
        </p>
        <p className="text-gray-400 text-sm mt-1">
          Equivalent annual return rate over the entire period
        </p>
      </div>

      <style>{`
        .slider::-webkit-slider-thumb {
          appearance: none;
          width: 16px;
          height: 16px;
          background: #6366f1;
          cursor: pointer;
          border-radius: 50%;
        }
        .slider::-moz-range-thumb {
          width: 16px;
          height: 16px;
          background: #6366f1;
          cursor: pointer;
          border-radius: 50%;
          border: none;
        }
      `}</style>
    </div>
  );
}

interface MetricCardProps {
  label: string;
  value: string;
  color: string;
}

export function MetricCard({ label, value, color }: MetricCardProps) {
  return (
    <div className="bg-slate-800/50 rounded-lg p-4">
      <p className="text-gray-400 text-sm mb-1">{label}</p>
      <p className={`text-xl font-bold ${color}`}>{value}</p>
    </div>
  );
}
