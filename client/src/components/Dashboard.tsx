import React, { useEffect, useState, Suspense } from "react";
import { useStaleResponseGuard } from "../hooks/useStaleResponseGuard";
import { Activity, ArrowUpRight, ShieldCheck, TrendingUp, Gauge, Network, Sparkles } from "lucide-react";
import { Link } from "react-router-dom";
import ApyHistoryChart from "./charts/ApyHistoryChart";
import { YieldFlowCanvas } from "./visualizations";
import MempoolVisualizer from "./mempool_graph/MempoolVisualizer";
import CorrelationHeatmap from "./charts/CorrelationHeatmap";
import { apiUrl } from "../lib/api";
import { useBackendStatus } from "../hooks/useBackendStatus";
import { BackendUnavailableAlert } from "./BackendUnavailable";
import ApyAttribution from "../features/yields/ApyAttribution";
import ConnectWalletButton from "./wallet/ConnectWalletButton";

interface YieldData {
  protocol: string;
  asset: string;
  apy: number;
  tvl: number;
  risk: string;
  attribution: {
    baseYield: number;
    incentives: number;
    compounding: number;
    tacticalRotation: number;
  };
}

export default function Dashboard() {
  const [yields, setYields] = useState<YieldData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showError, setShowError] = useState(true);
  const backendStatus = useBackendStatus();
  const [hoveredNode, setHoveredNode] = useState<number | null>(null);
  const [chartHovered, setChartHovered] = useState(false);

  const toggleRow = (index: number) => {
    setExpandedRows((prev) => ({ ...prev, [index]: !prev[index] }));
  };

  const [expandedRows, setExpandedRows] = useState<Record<number, boolean>>({});
  const { startRequest, isCurrent } = useStaleResponseGuard();

  useEffect(() => {
    const token = startRequest();
    fetch(apiUrl("/api/yields"))
      .then((res) => res.json())
      .then((data) => {
        if (!isCurrent(token)) return;
        setYields(data);
        setLoading(false);
      })
      .catch((err) => {
        if (!isCurrent(token)) return;
        console.error("Failed to fetch yields", err);
        setError("Unable to fetch yield data from backend");
        setLoading(false);
      });
  }, []);

  return (
    <div className="home-experience">
      {/* Background large lettering decor */}
      <div className="backdrop-text-container">
        <div className="backdrop-text backdrop-text-left">STELLAR</div>
        <div className="backdrop-text backdrop-text-right">YIELD</div>
      </div>

      {error && showError && backendStatus === "unavailable" && (
        <BackendUnavailableAlert
          message="Yield data is currently unavailable. Showing cached or offline data if available."
          onDismiss={() => setShowError(false)}
        />
      )}

      <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
        <div className="glass-card border-l-4 border-[#6C5DD3] p-6">
          <div className="mb-4 flex items-start justify-between">
            <div>
              <p className="text-sm font-medium tracking-wide text-gray-400">
                TOTAL VALUE LOCKED
              </p>
              <h3 className="mt-1 text-3xl font-bold shadow-sm">$4,250,000</h3>
            </div>
          </div>
        </div>
      </div>

      {/* Main floating card board */}
      <div className="home-card-wrapper">
        <section className="hero-shell">
          {/* Header Navbar inside the Hero shell */}
          <div className="hero-topbar">
            <Link to="/" className="hero-brand" aria-label="StellarYield home">
              <svg viewBox="0 0 256 256" fill="none" className="w-8 h-8 flex-shrink-0" xmlns="http://www.w3.org/2000/svg">
                <path d="M 0 256 L 0 128 L 128 128 Z M 128 256 L 128 128 L 256 128 Z M 0 128 L 0 0 L 128 0 Z M 128 128 L 128 0 L 256 0 Z" fill="rgb(84, 84, 84)"></path>
              </svg>
              <span>StellarYield</span>
            </Link>
            <div className="hero-nav" aria-label="Featured routes">
              <Link to="/">Yield Vaults</Link>
              <Link to="/">Strategies</Link>
              <Link to="/">APY Compare</Link>
            </div>
            <ConnectWalletButton />
          </div>

          <div className="hero-copy">
            <div className="eyebrow">
              <Sparkles size={13} className="mr-1" />
              Soroban Smart Yield Hub
            </div>
            <h2 className="leading-tight">
              <span className="font-serif block text-[2.75rem] font-medium text-slate-800 italic mb-2">Turn Fragmented DeFi</span>
              <span className="font-sans font-extrabold text-[2.5rem] tracking-tight text-slate-900 block">
                Yield Into <span className="text-blue-600">Stellar Growth <TrendingUp size={28} className="inline text-blue-600 ml-1 align-middle" /></span>
              </span>
            </h2>
            <p>
              Monitor Stellar vaults, automatically calculate risk-adjusted APYs, and deploy capital across Soroban automated liquidity pools and vaults with absolute clarity.
            </p>

            <div className="hero-actions-container">
              <div className="hero-actions">
                <ConnectWalletButton />
                <a href="#features" className="secondary-action">
                  Learn More
                </a>
              </div>
            </div>
          </div>
        </section>

        {/* Feature/Business Results Section */}
        <section id="features" className="results-section">
          <div className="section-heading">
            <span className="mini-pill">
              <Gauge size={12} className="mr-1" />
              Automation Workspace
            </span>
            <h3>Yield Routing that Delivers Stellar Results</h3>
            <p>
              Transform your idle capital into a high-performance yield asset. Access advanced smart routing, live-tracking vaults, and clear metrics.
            </p>
          </div>

          <div className="feature-grid">
            {/* Card 1: Risk-Aware Routing */}
            <article className="feature-card">
              <div className="feature-art">
                <div className="mock-editor">
                  <div className="mock-editor-header">
                    <div className="mock-editor-dot bg-rose-400" />
                    <div className="mock-editor-dot bg-amber-400" />
                    <div className="mock-editor-dot bg-emerald-400" />
                    <span className="absolute left-1/2 transform -translate-x-1/2 text-[9px] text-slate-400 font-bold tracking-wider uppercase">Route Builder</span>
                  </div>
                  <div className="mock-editor-content">
                    <div className="mock-editor-row">
                      <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-emerald-500" /> Blend Vault</span>
                      <span className="mock-editor-tag bg-emerald-100 text-emerald-800">Stable APY</span>
                    </div>
                    <div className="mock-editor-row">
                      <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-pink-500" /> Soroswap LP</span>
                      <span className="mock-editor-tag bg-pink-100 text-pink-800">High Liquid</span>
                    </div>
                    <div className="mock-editor-row">
                      <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-blue-500" /> DeFindex</span>
                      <span className="mock-editor-tag bg-blue-100 text-blue-800">Balanced</span>
                    </div>
                  </div>
                </div>
              </div>
              <h4>Risk-Aware Routing</h4>
              <p>Compare APY, liquidity depth, and protocol reliability before capital moves. Keep control over your risks.</p>
            </article>

            {/* Card 2: Vault Automation */}
            <article className="feature-card" onMouseEnter={() => setChartHovered(true)} onMouseLeave={() => setChartHovered(false)}>
              <div className="feature-art">
                <div className="mock-chart-container">
                  <div className="mock-chart-header">
                    <div>
                      <div className="mock-chart-title">YIELD GENERATED</div>
                      <div className="mock-chart-value">$81,555.49</div>
                    </div>
                    <div className="mock-chart-pill">+12.4%</div>
                  </div>
                  <div className="mock-chart-svg">
                    <svg viewBox="0 0 200 80" width="100%" height="100%">
                      <path d="M 0,70 L 0,70 Q 30,50 60,65 T 120,40 T 170,25 T 200,10 L 200,80 L 0,80 Z" fill="rgba(37, 99, 235, 0.08)" />
                      <path d="M 0,70 Q 30,50 60,65 T 120,40 T 170,25 T 200,10" fill="none" stroke="#2563eb" strokeWidth="2.5" strokeLinecap="round" />
                      <circle cx="170" cy="25" r={chartHovered ? 5 : 3} fill="#2563eb" stroke="white" strokeWidth="1.5" className="transition-all duration-300" />
                      <circle cx="200" cy="10" r={chartHovered ? 5 : 3} fill="#10b981" stroke="white" strokeWidth="1.5" className="transition-all duration-300" />
                      {chartHovered && (
                        <g>
                          <line x1="170" y1="25" x2="170" y2="80" stroke="#94a3b8" strokeWidth="1" strokeDasharray="2 2" />
                          <line x1="200" y1="10" x2="200" y2="80" stroke="#94a3b8" strokeWidth="1" strokeDasharray="2 2" />
                        </g>
                      )}
                    </svg>
                  </div>
                </div>
              </div>
              <h4>Vault Automation</h4>
              <p>Surface rebalance opportunities and auto-execute optimal swaps for Stellar yield vaults to capture high yield.</p>
            </article>

            {/* Card 3: Portfolio Intelligence */}
            <article className="feature-card">
              <div className="feature-art">
                <div className="mock-network-container">
                  <svg className="absolute inset-0 w-full h-full" xmlns="http://www.w3.org/2000/svg">
                    <line x1="50%" y1="50%" x2="20%" y2="25%" stroke="#cbd5e1" strokeWidth="1.5" strokeDasharray="3 3" />
                    <line x1="50%" y1="50%" x2="80%" y2="25%" stroke="#cbd5e1" strokeWidth="1.5" strokeDasharray="3 3" />
                    <line x1="50%" y1="50%" x2="75%" y2="75%" stroke="#cbd5e1" strokeWidth="1.5" strokeDasharray="3 3" />
                    <line x1="50%" y1="50%" x2="25%" y2="75%" stroke="#cbd5e1" strokeWidth="1.5" strokeDasharray="3 3" />
                    {hoveredNode !== null && (
                      <circle cx="50%" cy="50%" r="48" fill="none" stroke="#3b82f6" strokeWidth="1" strokeDasharray="4 4" className="animate-spin duration-1000" />
                    )}
                  </svg>
                  <div 
                    className="network-node node-main"
                    title="Router Hub"
                    onMouseEnter={() => setHoveredNode(0)}
                    onMouseLeave={() => setHoveredNode(null)}
                  >
                    <Network size={18} />
                  </div>
                  <div 
                    className="network-node node-child" 
                    style={{ left: '20%', top: '25%' }}
                    title="Blend Protocol"
                    onMouseEnter={() => setHoveredNode(1)}
                    onMouseLeave={() => setHoveredNode(null)}
                  >
                    <span className="text-[9px] font-black text-slate-700">BL</span>
                  </div>
                  <div 
                    className="network-node node-child" 
                    style={{ left: '80%', top: '25%' }}
                    title="Soroswap DEX"
                    onMouseEnter={() => setHoveredNode(2)}
                    onMouseLeave={() => setHoveredNode(null)}
                  >
                    <span className="text-[9px] font-black text-pink-600">SS</span>
                  </div>
                  <div 
                    className="network-node node-child" 
                    style={{ left: '75%', top: '75%' }}
                    title="DeFindex Vaults"
                    onMouseEnter={() => setHoveredNode(3)}
                    onMouseLeave={() => setHoveredNode(null)}
                  >
                    <span className="text-[9px] font-black text-emerald-600">DF</span>
                  </div>
                  <div 
                    className="network-node node-child" 
                    style={{ left: '25%', top: '75%' }}
                    title="Stellar Anchors"
                    onMouseEnter={() => setHoveredNode(4)}
                    onMouseLeave={() => setHoveredNode(null)}
                  >
                    <span className="text-[9px] font-black text-blue-600">XL</span>
                  </div>
                </div>
              </div>
              <h4>Portfolio Intelligence</h4>
              <p>Track allocation drift, TVL movements, and strategy health metrics in one single dashboard workspace.</p>
            </article>
          </div>
        </section>
      </div>

      {/* Premium Footer */}
      <footer className="premium-footer">
        <div className="footer-top">
          <div className="footer-brand-column">
            <Link to="/" className="hero-brand" style={{ padding: 0 }}>
              <svg viewBox="0 0 256 256" fill="none" className="w-8 h-8 flex-shrink-0" xmlns="http://www.w3.org/2000/svg">
                <path d="M 0 256 L 0 128 L 128 128 Z M 128 256 L 128 128 L 256 128 Z M 0 128 L 0 0 L 128 0 Z M 128 128 L 128 0 L 256 0 Z" fill="rgb(84, 84, 84)"></path>
              </svg>
              <span>StellarYield</span>
            </Link>
            <p className="footer-desc">
              Optimizing DeFi yield routing, automated liquidity provisioning, and asset management on the Stellar and Soroban network.
            </p>
          </div>
          
          <div className="footer-column">
            <span className="footer-column-title">Products</span>
            <Link to="/" className="footer-link">Yield Vaults</Link>
            <Link to="/" className="footer-link">Strategies</Link>
            <Link to="/" className="footer-link">Compare APY</Link>
            <Link to="/" className="footer-link">Yield Calculator</Link>
          </div>

          <div className="footer-column">
            <span className="footer-column-title">Analytics</span>
            <Link to="/" className="footer-link">My Portfolio</Link>
            <Link to="/" className="footer-link">PnL Tracking</Link>
            <Link to="/" className="footer-link">Tax Exports</Link>
            <Link to="/" className="footer-link">Liquidity Depth</Link>
          </div>

          <div className="footer-column">
            <span className="footer-column-title">Governance</span>
            <Link to="/" className="footer-link">Proposals</Link>
            <Link to="/" className="footer-link">Community Quests</Link>
            <Link to="/" className="footer-link">Leaderboard</Link>
            <Link to="/" className="footer-link">Referrals</Link>
          </div>

          <div className="footer-column">
            <span className="footer-column-title">Safety</span>
            <Link to="/" className="footer-link">Incident Reports</Link>
            <Link to="/" className="footer-link">Stress Test</Link>
            <Link to="/" className="footer-link">Token Vesting</Link>
            <Link to="/" className="footer-link">Session Security</Link>
          </div>
        </div>

        <div className="footer-bottom">
          <span>&copy; {new Date().getFullYear()} StellarYield. Built on Soroban. All rights reserved.</span>
          <div className="footer-bottom-links">
            <Link to="/" className="footer-link">Privacy Policy</Link>
            <Link to="/" className="footer-link">Terms of Service</Link>
            <Link to="/" className="footer-link">Security Audit</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
