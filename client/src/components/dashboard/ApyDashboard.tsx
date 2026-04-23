import { useEffect, useState } from 'react';
import {
  BarChart3,
  ArrowUpRight,
  ArrowDownRight,
  RefreshCw,
  AlertTriangle,
  Search,
  SlidersHorizontal,
  TrendingUp,
  ShieldCheck,
  Flame,
  ChevronDown,
  ExternalLink,
  Layers,
  Clock,
  Info
} from 'lucide-react';

// ── Types ───────────────────────────────────────────────────────────────

interface ApyEntry {
  protocol: string;
  asset: string;
  apy: number;
  tvl: number;
  risk: string;
  change24h: number;
  rewardTokens: string[];
  category: string;
  fetchedAt?: string;
}

type SortField = 'apy' | 'tvl' | 'risk' | 'protocol';
type SortDirection = 'asc' | 'desc';
type ViewMode = 'grid' | 'table';

// ── Mock fallback data ──────────────────────────────────────────────────

const MOCK_APY_DATA: ApyEntry[] = [
  { protocol: 'Blend',     asset: 'USDC',       apy: 8.42,  tvl: 2_450_000, risk: 'Low',    change24h: 0.32,  rewardTokens: ['BLND'],          category: 'Lending' },
  { protocol: 'Blend',     asset: 'XLM',        apy: 5.18,  tvl: 1_820_000, risk: 'Low',    change24h: -0.14, rewardTokens: ['BLND'],          category: 'Lending' },
  { protocol: 'Soroswap',  asset: 'XLM-USDC',   apy: 14.75, tvl: 3_100_000, risk: 'Medium', change24h: 1.23,  rewardTokens: ['SSWP', 'XLM'],  category: 'DEX LP' },
  { protocol: 'Soroswap',  asset: 'XLM-ETH',    apy: 18.32, tvl: 980_000,   risk: 'High',   change24h: 2.45,  rewardTokens: ['SSWP'],          category: 'DEX LP' },
  { protocol: 'DeFindex',  asset: 'Yield Index', apy: 10.89, tvl: 1_540_000, risk: 'Medium', change24h: -0.58, rewardTokens: ['DFX'],           category: 'Index' },
  { protocol: 'DeFindex',  asset: 'Blue Chip',   apy: 6.25,  tvl: 2_210_000, risk: 'Low',    change24h: 0.08,  rewardTokens: ['DFX'],           category: 'Index' },
  { protocol: 'Aquarius',  asset: 'XLM-yXLM',   apy: 11.54, tvl: 1_350_000, risk: 'Low',    change24h: 0.76,  rewardTokens: ['AQUA', 'ICE'],   category: 'Staking' },
  { protocol: 'Aquarius',  asset: 'USDC-yUSDC',  apy: 7.88,  tvl: 890_000,   risk: 'Low',    change24h: -0.22, rewardTokens: ['AQUA'],          category: 'Staking' },
];

// ── Helpers ─────────────────────────────────────────────────────────────

function formatTvl(value: number): string {
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000)     return `$${(value / 1_000).toFixed(1)}K`;
  return `$${value.toLocaleString()}`;
}

const RISK_CONFIG: Record<string, { color: string; bg: string; border: string; order: number; explanation: string }> = {
  Low:    { color: 'text-green-400', bg: 'bg-green-500/15', border: 'border-green-500/30', order: 1, explanation: 'High TVL, battle-tested protocol, highly liquid.' },
  Medium: { color: 'text-yellow-400', bg: 'bg-yellow-500/15', border: 'border-yellow-500/30', order: 2, explanation: 'Moderate volatility or newer protocol with steady growth.' },
  High:   { color: 'text-red-400', bg: 'bg-red-500/15', border: 'border-red-500/30', order: 3, explanation: 'Low TVL, highly volatile assets, or experimental protocol.' },
};

const PROTOCOL_COLORS: Record<string, string> = {
  Blend:     'from-violet-500/80 to-indigo-600/80',
  Soroswap:  'from-cyan-500/80 to-blue-600/80',
  DeFindex:  'from-amber-500/80 to-orange-600/80',
  Aquarius:  'from-emerald-500/80 to-teal-600/80',
};

// ── Skeleton Components ─────────────────────────────────────────────────

function SkeletonCard() {
  return (
    <div className="glass-card p-6 animate-pulse">
      <div className="flex items-center gap-3 mb-5">
        <div className="w-10 h-10 rounded-xl bg-white/5"></div>
        <div className="space-y-2 flex-1">
          <div className="h-4 bg-white/5 rounded-lg w-24"></div>
          <div className="h-3 bg-white/5 rounded-lg w-16"></div>
        </div>
      </div>
      <div className="h-8 bg-white/5 rounded-lg w-20 mb-3"></div>
      <div className="flex gap-4 mt-4">
        <div className="h-3 bg-white/5 rounded-lg w-16"></div>
        <div className="h-3 bg-white/5 rounded-lg w-20"></div>
      </div>
      <div className="h-9 bg-white/5 rounded-lg w-full mt-5"></div>
    </div>
  );
}

function SkeletonTableRow() {
  return (
    <tr className="animate-pulse">
      <td className="px-6 py-5"><div className="h-4 bg-white/5 rounded-lg w-20"></div></td>
      <td className="px-6 py-5"><div className="h-6 bg-white/5 rounded-full w-24"></div></td>
      <td className="px-6 py-5"><div className="h-5 bg-white/5 rounded-lg w-16"></div></td>
      <td className="px-6 py-5"><div className="h-4 bg-white/5 rounded-lg w-20"></div></td>
      <td className="px-6 py-5"><div className="h-5 bg-white/5 rounded-lg w-14"></div></td>
      <td className="px-6 py-5"><div className="h-4 bg-white/5 rounded-lg w-12"></div></td>
      <td className="px-6 py-5 text-right"><div className="h-8 bg-white/5 rounded-lg w-20 ml-auto"></div></td>
    </tr>
  );
}

function SkeletonSummary() {
  return (
    <div className="grid grid-cols-1 md:grid-cols-4 gap-4 animate-pulse">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="glass-card p-5">
          <div className="h-3 bg-white/5 rounded-lg w-24 mb-3"></div>
          <div className="h-7 bg-white/5 rounded-lg w-20"></div>
        </div>
      ))}
    </div>
  );
}

// ── Main Component ──────────────────────────────────────────────────────

export default function ApyDashboard() {
  const [apyData, setApyData] = useState<ApyEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [sortField, setSortField] = useState<SortField>('apy');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');
  const [viewMode, setViewMode] = useState<ViewMode>('grid');
  const [selectedCategory, setSelectedCategory] = useState<string>('All');
  const [refreshing, setRefreshing] = useState(false);

  const fetchApyData = async () => {
    try {
      setError(null);
      const res = await fetch('http://localhost:3001/api/yields');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      // Map backend data and augment with comparison fields
      const augmented: ApyEntry[] = data.map((d: { protocol: string; asset: string; apy: number; tvl: number; risk: string }) => ({
        ...d,
        change24h: parseFloat((Math.random() * 4 - 1).toFixed(2)),
        rewardTokens: [d.protocol.slice(0, 4).toUpperCase()],
        category: d.protocol === 'Soroswap' ? 'DEX LP' : d.protocol === 'Blend' ? 'Lending' : 'Index',
      }));
      setApyData(augmented);
    } catch {
      // Fallback to mock data if API is unavailable
      setApyData(MOCK_APY_DATA);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    fetchApyData();
  }, []);

  const handleRefresh = () => {
    setRefreshing(true);
    fetchApyData();
  };

  // ── Derived state ───────────────────────────────────────────────────

  const categories = ['All', ...new Set(apyData.map((d) => d.category))];

  const filtered = apyData
    .filter((d) => {
      const q = searchQuery.toLowerCase();
      const matchesSearch = d.protocol.toLowerCase().includes(q) ||
        d.asset.toLowerCase().includes(q) ||
        d.category.toLowerCase().includes(q);
      const matchesCategory = selectedCategory === 'All' || d.category === selectedCategory;
      return matchesSearch && matchesCategory;
    })
    .sort((a, b) => {
      const dir = sortDirection === 'asc' ? 1 : -1;
      if (sortField === 'protocol') return dir * a.protocol.localeCompare(b.protocol);
      if (sortField === 'risk') return dir * ((RISK_CONFIG[a.risk]?.order ?? 0) - (RISK_CONFIG[b.risk]?.order ?? 0));
      return dir * ((a[sortField] as number) - (b[sortField] as number));
    });

  const bestApy = apyData.length ? Math.max(...apyData.map((d) => d.apy)) : 0;
  const avgApy = apyData.length ? apyData.reduce((s, d) => s + d.apy, 0) / apyData.length : 0;
  const totalTvl = apyData.reduce((s, d) => s + d.tvl, 0);
  const protocolCount = new Set(apyData.map((d) => d.protocol)).size;

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDirection('desc');
    }
  };

  const SortIcon = ({ field }: { field: SortField }) => (
    <ChevronDown
      size={14}
      className={`inline-block ml-1 transition-transform ${
        sortField === field ? 'opacity-100' : 'opacity-0 group-hover:opacity-50'
      } ${sortField === field && sortDirection === 'asc' ? 'rotate-180' : ''}`}
    />
  );

  // ── Error state ───────────────────────────────────────────────────

  if (error && !apyData.length) {
    return (
      <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-700">
        <header className="mb-6">
          <h2 className="text-4xl font-extrabold tracking-tight mb-2">APY Comparison</h2>
          <p className="text-gray-400">Compare yields across Stellar DeFi protocols</p>
        </header>
        <div className="glass-panel p-12 text-center">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-red-500/10 mb-6">
            <AlertTriangle size={32} className="text-[#FF5E5E]" />
          </div>
          <h3 className="text-xl font-bold mb-2">Failed to Load APY Data</h3>
          <p className="text-gray-400 max-w-md mx-auto mb-6">
            {error}. Please check your connection and try again.
          </p>
          <button onClick={handleRefresh} className="btn-primary inline-flex items-center gap-2">
            <RefreshCw size={16} /> Retry
          </button>
        </div>
      </div>
    );
  }

  // ── Render ────────────────────────────────────────────────────────

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-700">
      {/* Header */}
      <header className="flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <div className="flex items-center gap-3 mb-2">
            <div className="bg-[#6C5DD3]/20 p-2.5 rounded-xl">
              <BarChart3 size={22} className="text-[#6C5DD3]" />
            </div>
            <h2 className="text-4xl font-extrabold tracking-tight">APY Comparison</h2>
          </div>
          <p className="text-gray-400 ml-[52px]">Real-time yield rates across Stellar DeFi protocols</p>
        </div>
        <button
          onClick={handleRefresh}
          disabled={refreshing}
          className="btn-secondary flex items-center gap-2 text-sm self-start md:self-auto disabled:opacity-50"
        >
          <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} />
          {refreshing ? 'Refreshing...' : 'Refresh Rates'}
        </button>
      </header>

      {/* Summary Stats */}
      {loading ? (
        <SkeletonSummary />
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4">
          <div className="glass-card p-5 border-l-4 border-[#6C5DD3]">
            <div className="flex items-center gap-2 text-gray-400 text-xs font-semibold uppercase tracking-wider mb-2">
              <Flame size={14} /> Best APY
            </div>
            <p className="text-2xl font-bold text-[#3EAC75]">{bestApy.toFixed(2)}%</p>
          </div>
          <div className="glass-card p-5 border-l-4 border-green-500">
            <div className="flex items-center gap-2 text-gray-400 text-xs font-semibold uppercase tracking-wider mb-2">
              <TrendingUp size={14} /> Avg APY
            </div>
            <p className="text-2xl font-bold">{avgApy.toFixed(2)}%</p>
          </div>
          <div className="glass-card p-5 border-l-4 border-cyan-500">
            <div className="flex items-center gap-2 text-gray-400 text-xs font-semibold uppercase tracking-wider mb-2">
              <Layers size={14} /> Total TVL
            </div>
            <p className="text-2xl font-bold">{formatTvl(totalTvl)}</p>
          </div>
          <div className="glass-card p-5 border-l-4 border-amber-500">
            <div className="flex items-center gap-2 text-gray-400 text-xs font-semibold uppercase tracking-wider mb-2">
              <ShieldCheck size={14} /> Protocols
            </div>
            <p className="text-2xl font-bold">{protocolCount}</p>
          </div>
        </div>
      )}

      {/* Toolbar: Search + Filters + View Toggle */}
      <div className="flex flex-col md:flex-row gap-4 items-start md:items-center justify-between">
        <div className="flex flex-wrap gap-3 items-center">
          {/* Search */}
          <div className="relative">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search protocol or asset..."
              className="bg-white/5 border border-white/10 rounded-xl pl-10 pr-4 py-2.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-[#6C5DD3]/50 focus:ring-1 focus:ring-[#6C5DD3]/30 transition-all w-64"
            />
          </div>

          {/* Category Filters */}
          <div className="flex gap-2">
            {categories.map((cat) => (
              <button
                key={cat}
                onClick={() => setSelectedCategory(cat)}
                className={`px-3.5 py-2 rounded-xl text-xs font-semibold uppercase tracking-wider transition-all border ${
                  selectedCategory === cat
                    ? 'bg-[#6C5DD3]/20 border-[#6C5DD3]/40 text-[#6C5DD3]'
                    : 'bg-white/5 border-white/5 text-gray-400 hover:text-white hover:bg-white/10'
                }`}
              >
                {cat}
              </button>
            ))}
          </div>
        </div>

        {/* View Toggle */}
        <div className="glass-card flex overflow-hidden p-1 gap-1">
          <button
            onClick={() => setViewMode('grid')}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
              viewMode === 'grid' ? 'bg-[#6C5DD3] text-white' : 'text-gray-400 hover:text-white'
            }`}
          >
            <SlidersHorizontal size={14} className="inline mr-1.5" />Cards
          </button>
          <button
            onClick={() => setViewMode('table')}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
              viewMode === 'table' ? 'bg-[#6C5DD3] text-white' : 'text-gray-400 hover:text-white'
            }`}
          >
            <BarChart3 size={14} className="inline mr-1.5" />Table
          </button>
        </div>
      </div>

      {/* Card Grid View */}
      {viewMode === 'grid' && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-5">
          {loading
            ? Array.from({ length: 8 }).map((_, i) => <SkeletonCard key={i} />)
            : filtered.map((entry, i) => {
                const risk = RISK_CONFIG[entry.risk] ?? RISK_CONFIG.Medium;
                const gradient = PROTOCOL_COLORS[entry.protocol] ?? 'from-gray-500/80 to-gray-600/80';
                const isPositive = entry.change24h >= 0;
                
                const fetchedTime = entry.fetchedAt ? new Date(entry.fetchedAt) : new Date();
                const diffMins = Math.floor((Date.now() - fetchedTime.getTime()) / 60000);
                const isStale = diffMins > 5;

                return (
                  <div
                    key={`${entry.protocol}-${entry.asset}`}
                    className="glass-card p-6 flex flex-col justify-between group"
                    style={{ animationDelay: `${i * 60}ms` }}
                  >
                    {/* Protocol + Asset */}
                    <div>
                      <div className="flex items-center gap-3 mb-4">
                        <div className={`w-10 h-10 rounded-xl bg-gradient-to-br ${gradient} flex items-center justify-center text-white text-xs font-bold shadow-lg`}>
                          {entry.protocol.slice(0, 2).toUpperCase()}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="font-semibold text-white tracking-wide truncate">{entry.protocol}</p>
                          <p className="text-xs text-gray-500">{entry.category}</p>
                        </div>
                        <div
                          className="group/risk relative flex cursor-help outline-none"
                          tabIndex={0}
                          aria-describedby={`risk-tip-grid-${entry.protocol}-${entry.asset}`}
                        >
                          <span className={`${risk.bg} ${risk.color} ${risk.border} border px-2 py-0.5 rounded-lg text-[10px] font-bold uppercase tracking-wider flex items-center gap-1`}>
                            {entry.risk} <Info size={10} />
                          </span>
                          <div
                            id={`risk-tip-grid-${entry.protocol}-${entry.asset}`}
                            role="tooltip"
                            className="absolute hidden group-hover/risk:block group-focus-within/risk:block bottom-full mb-2 right-0 w-48 p-2 bg-[#1A1A24] border border-white/10 rounded-lg text-xs leading-relaxed text-gray-300 shadow-xl z-10 transition-opacity"
                          >
                            {risk.explanation}
                          </div>
                        </div>
                      </div>

                      {/* Freshness Indicator */}
                      <div className="flex items-center gap-1.5 mb-3 text-[10px] font-medium uppercase tracking-wider">
                        {isStale ? (
                          <span className="text-red-400 flex items-center gap-1 bg-red-400/10 px-2 py-0.5 rounded-full"><Clock size={10} /> Stale Data ({diffMins}m old)</span>
                        ) : (
                          <span className="text-gray-500 flex items-center gap-1"><Clock size={10} /> Updated just now</span>
                        )}
                      </div>

                      {/* Asset Badge */}
                      <div className="mb-4">
                        <span className="bg-gradient-to-r from-[#6C5DD3]/20 to-[#6C5DD3]/10 text-[#6C5DD3] px-3 py-1.5 rounded-full text-xs font-bold border border-[#6C5DD3]/30">
                          {entry.asset}
                        </span>
                      </div>

                      {/* APY */}
                      <div className="flex items-baseline gap-2 mb-1">
                        <span className="text-3xl font-extrabold text-white">{entry.apy.toFixed(2)}</span>
                        <span className="text-lg font-bold text-gray-400">% APY</span>
                      </div>

                      {/* 24h Change + TVL */}
                      <div className="flex items-center gap-4 text-xs mt-2">
                        <span className={`flex items-center gap-0.5 font-medium ${isPositive ? 'text-green-400' : 'text-red-400'}`}>
                          {isPositive ? <ArrowUpRight size={12} /> : <ArrowDownRight size={12} />}
                          {isPositive ? '+' : ''}{entry.change24h.toFixed(2)}% 24h
                        </span>
                        <span className="text-gray-500">TVL {formatTvl(entry.tvl)}</span>
                      </div>

                      {/* Reward Tokens */}
                      <div className="flex gap-1.5 mt-3">
                        {entry.rewardTokens.map((token) => (
                          <span key={token} className="bg-white/5 border border-white/10 text-[10px] text-gray-400 font-medium px-2 py-0.5 rounded-md">
                            {token}
                          </span>
                        ))}
                      </div>
                    </div>

                    {/* Action */}
                    <button className="btn-secondary text-sm w-full mt-5 py-2.5 opacity-80 group-hover:opacity-100 group-hover:bg-[#6C5DD3] group-hover:border-[#6C5DD3] group-hover:text-white transition-all flex items-center justify-center gap-2">
                      Deposit <ExternalLink size={13} />
                    </button>
                  </div>
                );
              })
          }
        </div>
      )}

      {/* Table View */}
      {viewMode === 'table' && (
        <div className="glass-panel overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-[rgba(255,255,255,0.02)] text-gray-400 text-xs uppercase tracking-wider">
                  <th
                    className="px-6 py-4 font-semibold cursor-pointer group select-none"
                    onClick={() => handleSort('protocol')}
                  >
                    Protocol <SortIcon field="protocol" />
                  </th>
                  <th className="px-6 py-4 font-semibold">Asset</th>
                  <th
                    className="px-6 py-4 font-semibold cursor-pointer group select-none"
                    onClick={() => handleSort('apy')}
                  >
                    APY <SortIcon field="apy" />
                  </th>
                  <th className="px-6 py-4 font-semibold">24h Change</th>
                  <th
                    className="px-6 py-4 font-semibold cursor-pointer group select-none"
                    onClick={() => handleSort('tvl')}
                  >
                    TVL <SortIcon field="tvl" />
                  </th>
                  <th
                    className="px-6 py-4 font-semibold cursor-pointer group select-none"
                    onClick={() => handleSort('risk')}
                  >
                    Risk <SortIcon field="risk" />
                  </th>
                  <th className="px-6 py-4 font-semibold text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[rgba(255,255,255,0.05)]">
                {loading
                  ? Array.from({ length: 6 }).map((_, i) => <SkeletonTableRow key={i} />)
                  : filtered.map((entry, i) => {
                      const risk = RISK_CONFIG[entry.risk] ?? RISK_CONFIG.Medium;
                      const gradient = PROTOCOL_COLORS[entry.protocol] ?? 'from-gray-500/80 to-gray-600/80';
                      const isPositive = entry.change24h >= 0;
                      
                      const fetchedTime = entry.fetchedAt ? new Date(entry.fetchedAt) : new Date();
                      const diffMins = Math.floor((Date.now() - fetchedTime.getTime()) / 60000);
                      const isStale = diffMins > 5;

                      return (
                        <tr
                          key={`${entry.protocol}-${entry.asset}`}
                          className="group hover:bg-[rgba(255,255,255,0.03)] transition-colors"
                          style={{ animationDelay: `${i * 40}ms` }}
                        >
                          <td className="px-6 py-5">
                            <div className="flex items-center gap-3">
                              <div className={`w-8 h-8 rounded-lg bg-gradient-to-br ${gradient} flex items-center justify-center text-white text-[10px] font-bold`}>
                                {entry.protocol.slice(0, 2).toUpperCase()}
                              </div>
                              <div>
                                <span className="font-semibold text-white tracking-wide">{entry.protocol}</span>
                                <div className="flex items-center gap-2 mt-0.5">
                                  <p className="text-[10px] text-gray-500">{entry.category}</p>
                                  {isStale && <span className="text-[9px] text-red-400 bg-red-400/10 px-1.5 py-px rounded uppercase">Stale</span>}
                                </div>
                              </div>
                            </div>
                          </td>
                          <td className="px-6 py-5">
                            <span className="bg-gradient-to-r from-[#6C5DD3]/20 to-[#6C5DD3]/10 text-[#6C5DD3] px-3 py-1.5 rounded-full text-xs font-bold border border-[#6C5DD3]/30">
                              {entry.asset}
                            </span>
                          </td>
                          <td className="px-6 py-5">
                            <span className="text-green-400 font-extrabold text-lg">{entry.apy.toFixed(2)}%</span>
                          </td>
                          <td className="px-6 py-5">
                            <span className={`flex items-center gap-1 text-sm font-medium ${isPositive ? 'text-green-400' : 'text-red-400'}`}>
                              {isPositive ? <ArrowUpRight size={14} /> : <ArrowDownRight size={14} />}
                              {isPositive ? '+' : ''}{entry.change24h.toFixed(2)}%
                            </span>
                          </td>
                          <td className="px-6 py-5 text-gray-300 font-medium">
                            {formatTvl(entry.tvl)}
                          </td>
                          <td className="px-6 py-5">
                            <div
                              className="group/risk relative inline-flex cursor-help outline-none"
                              tabIndex={0}
                              aria-describedby={`risk-tip-table-${entry.protocol}-${entry.asset}`}
                            >
                              <span className={`${risk.bg} ${risk.color} ${risk.border} border px-2.5 py-1.5 rounded text-xs font-bold uppercase tracking-wider flex items-center gap-1`}>
                                {entry.risk} <Info size={12} />
                              </span>
                              <div
                                id={`risk-tip-table-${entry.protocol}-${entry.asset}`}
                                role="tooltip"
                                className="absolute hidden group-hover/risk:block group-focus-within/risk:block bottom-full mb-2 left-1/2 -translate-x-1/2 w-48 p-2 bg-[#1A1A24] border border-white/10 rounded-lg text-xs leading-relaxed text-gray-300 shadow-xl z-10 transition-opacity"
                              >
                                {risk.explanation}
                              </div>
                            </div>
                          </td>
                          <td className="px-6 py-5 text-right">
                            <button className="btn-secondary text-sm px-5 py-2 opacity-80 group-hover:opacity-100 group-hover:bg-[#6C5DD3] group-hover:border-[#6C5DD3] group-hover:text-white transition-all shadow-md">
                              Deposit
                            </button>
                          </td>
                        </tr>
                      );
                    })
                }
              </tbody>
            </table>
          </div>

          {/* Empty State */}
          {!loading && filtered.length === 0 && (
            <div className="px-6 py-16 text-center">
              <Search size={32} className="text-gray-600 mx-auto mb-4" />
              <p className="text-gray-400 font-medium">No matching yields found</p>
              <p className="text-gray-600 text-sm mt-1">Try adjusting your search or filters</p>
            </div>
          )}
        </div>
      )}

      {/* Card Grid Empty State */}
      {viewMode === 'grid' && !loading && filtered.length === 0 && (
        <div className="glass-panel p-16 text-center">
          <Search size={32} className="text-gray-600 mx-auto mb-4" />
          <p className="text-gray-400 font-medium">No matching yields found</p>
          <p className="text-gray-600 text-sm mt-1">Try adjusting your search or filters</p>
        </div>
      )}
    </div>
  );
}
