import {
  createBrowserRouter,
  RouterProvider,
  Outlet,
  Link,
  useLocation,
} from "react-router-dom";
import { lazy, useState } from "react";
import Dashboard from "./components/Dashboard";
import Vault from "./components/Vault";
const ApyDashboard = lazy(() => import("./components/dashboard/ApyDashboard"));
const AIAdvisor = lazy(() => import("./components/AIAdvisor"));
const PortfolioPage = lazy(
  () => import("./components/portfolio/PortfolioPage"),
);
const GovernanceDashboard = lazy(
  () => import("./pages/governance/GovernanceDashboard"),
);
const QuestsDashboard = lazy(() => import("./pages/quests/QuestsDashboard"));
const Leaderboard = lazy(() => import("./pages/leaderboard/Leaderboard"));
const ClaimRewards = lazy(() => import("./features/rewards/ClaimRewards"));
const PnLChart = lazy(() => import("./features/pnl/PnLChart"));
const TaxExport = lazy(() => import("./features/taxes/TaxExport"));
const ReferralDashboard = lazy(
  () => import("./features/referrals/ReferralDashboard"),
);
const VestingDashboard = lazy(() => import("./pages/vesting/VestingDashboard"));
const TransparencyDashboard = lazy(
  () => import("./pages/transparency/TransparencyDashboard"),
);
const RiskChronology = lazy(
  () => import("./pages/transparency/RiskChronology"),
);
const RelayerStatusPage = lazy(
  () => import("./pages/transparency/RelayerStatusPage"),
);
const StressTestDashboard = lazy(() => import("./pages/StressTestDashboard"));
const YieldForGood = lazy(() => import("./features/donations/YieldForGood"));
const YieldCalculator = lazy(
  () => import("./components/calculator/YieldCalculator"),
);
const StrategyComparison = lazy(
  () => import("./pages/strategy/StrategyComparison"),
);
const StablecoinBasketRebalance = lazy(
  () => import("./pages/strategy/StablecoinBasketRebalance"),
);
const DeltaNeutralUnwind = lazy(
  () => import("./pages/strategy/DeltaNeutralUnwind"),
);
const StrategyLeaderboard = lazy(
  () => import("./pages/leaderboard/StrategyLeaderboard"),
);
const TreasurySimulation = lazy(
  () => import("./pages/treasury/TreasurySimulation"),
);
const WalletSessionReview = lazy(() => import("./auth/WalletSessionReview"));
const FragmentationDashboard = lazy(() =>
  import("./features/fragmentation").then((m) => ({
    default: m.FragmentationDashboard,
  })),
);
const ReallocationTimelinePlanner = lazy(() =>
  import("./portfolio/ReallocationTimelinePlanner").then((m) => ({
    default: m.ReallocationTimelinePlanner,
  })),
);
import ConnectWalletButton from "./components/wallet/ConnectWalletButton";
import NotificationBell from "./components/Navigation/NotificationBell";
import OnRampModal from "./features/onramp/OnRampModal";
import { useWallet } from "./context/useWallet";
import { NotificationProvider } from "./context/NotificationContext";
import RouteBoundary from "./components/common/RouteBoundary";
import RequireOnboarding from "./components/common/RequireOnboarding";
import {
  Landmark,
  Zap,
  BarChart3,
  Menu,
  X,
  Settings,
  Bell,
  Activity,
} from "lucide-react";
import "./index.css";
import SettingsModal from "./features/settings/SettingsModal";
import AlertsModal from "./features/alerts/AlertsModal";
import { DiagnosticsModal, DiagnosticsTrigger } from "./components/diagnostics";
import { listenToOpenDiagnostics } from "./lib/config";
import { useEffect } from "react";

// Vault IDs available for APY alerts (matches protocol names from yieldService)
const VAULT_OPTIONS = ["Blend", "Soroswap", "DeFindex"];

function GoalPlannerPage() {
  return (
    <ReallocationTimelinePlanner
      planName="Goal Planner"
      status="draft"
      steps={[
        {
          stepId: "goal-planner-draft",
          scheduledAt: new Date().toISOString(),
          expectedFeeUsd: 0,
          expectedRecoveryHours: 0,
          allocations: { Blend: 40, Soroswap: 30, DeFindex: 30 },
        },
      ]}
    />
  );
}

// Layout Component
const RootLayout = () => {
  const { isConnected, walletAddress } = useWallet();
  const [isOnRampOpen, setIsOnRampOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isAlertsOpen, setIsAlertsOpen] = useState(false);
  const [isDiagnosticsOpen, setIsDiagnosticsOpen] = useState(false);
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const location = useLocation();
  const isHomePage = location.pathname === "/";

  useEffect(() => {
    return listenToOpenDiagnostics(() => setIsDiagnosticsOpen(true));
  }, []);

  return (
    <div className="min-h-screen flex flex-col">
      {/* On-Ramp Modal */}
      {isConnected && walletAddress && (
        <OnRampModal
          isOpen={isOnRampOpen}
          onClose={() => setIsOnRampOpen(false)}
          walletAddress={walletAddress}
        />
      )}
      {/* Settings Modal */}
      <SettingsModal isOpen={isSettingsOpen} onClose={() => setIsSettingsOpen(false)} />
      {/* Diagnostics Modal */}
      <DiagnosticsModal
        isOpen={isDiagnosticsOpen}
        onClose={() => setIsDiagnosticsOpen(false)}
      <SettingsModal
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
      />
      {/* APY Alerts Modal */}
      {isConnected && walletAddress && (
        <AlertsModal
          isOpen={isAlertsOpen}
          onClose={() => setIsAlertsOpen(false)}
          walletAddress={walletAddress}
          vaultOptions={VAULT_OPTIONS}
        />
      )}
      {/* Navigation Bar */}
      {!isHomePage && (
        <nav className="app-nav glass-panel mx-3 mt-4 px-4 py-3.5 flex justify-between items-center mb-6 sticky top-3 z-50 shadow-2xl">
          <div className="flex items-center gap-2 shrink-0">
            <svg
              viewBox="0 0 256 256"
              fill="none"
              className="w-8 h-8 flex-shrink-0"
              xmlns="http://www.w3.org/2000/svg"
            >
              <path
                d="M 0 256 L 0 128 L 128 128 Z M 128 256 L 128 128 L 256 128 Z M 0 128 L 0 0 L 128 0 Z M 128 128 L 128 0 L 256 0 Z"
                fill="rgb(84, 84, 84)"
              ></path>
            </svg>
            <h1 className="text-base font-bold tracking-wide text-slate-900">
              Stellar Yield
            </h1>
          </div>

          <div className="hidden md:flex flex-1 min-w-0 nav-links">
            <div className="flex gap-4 xl:gap-5 items-center text-[0.82rem] font-semibold text-slate-600 px-4">
              <Link
                to="/"
                className="hover:text-slate-900 transition-colors flex items-center gap-1.5"
              >
                <Landmark size={15} /> Yield Vaults
              </Link>
              <Link
                to="/"
                className="hover:text-slate-900 transition-colors flex items-center gap-1.5"
              >
                <Zap size={15} /> Strategies
              </Link>
              <Link
                to="/"
                className="hover:text-slate-900 transition-colors flex items-center gap-1.5"
              >
                <BarChart3 size={15} /> APY Compare
              </Link>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <NotificationBell />
            {isConnected && (
              <button
                type="button"
                onClick={() => setIsAlertsOpen(true)}
                aria-label="Open APY alerts"
                className="p-2 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-600 hover:text-slate-900 transition-colors"
              >
                <Bell size={16} />
              </button>
            )}
            <DiagnosticsTrigger onClick={() => setIsDiagnosticsOpen(true)} />
            <button
              type="button"
              onClick={() => setIsSettingsOpen(true)}
              aria-label="Open transaction settings"
              className="p-2 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-600 hover:text-slate-900 transition-colors"
            >
              <Settings size={16} />
            </button>
            <ConnectWalletButton />
            {/* Mobile menu toggle — visible below md breakpoint */}
            <button
              type="button"
              onClick={() => setIsDrawerOpen((v) => !v)}
              aria-label={
                isDrawerOpen ? "Close navigation menu" : "Open navigation menu"
              }
              aria-expanded={isDrawerOpen}
              aria-controls="mobile-nav-drawer"
              className="md:hidden p-2 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-600 hover:text-slate-900 transition-colors"
            >
              {isDrawerOpen ? <X size={18} /> : <Menu size={18} />}
            </button>
          </div>
        </nav>
      )}

      {/* Mobile Navigation Drawer */}
      {isDrawerOpen && (
        <div
          id="mobile-nav-drawer"
          role="dialog"
          aria-label="Navigation menu"
          className="md:hidden fixed inset-0 z-40 flex"
        >
          {/* Backdrop */}
          <div
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            onClick={() => setIsDrawerOpen(false)}
            aria-hidden="true"
          />
          {/* Drawer panel */}
          <nav
            className="relative ml-auto w-72 h-full glass-panel rounded-none rounded-l-2xl overflow-y-auto flex flex-col gap-1 px-4 py-6"
            aria-label="Mobile navigation"
            onClick={(event) => {
              if ((event.target as HTMLElement).closest("a")) {
                setIsDrawerOpen(false);
              }
            }}
          >
            <div className="flex items-center justify-between mb-4">
              <span className="text-sm font-semibold text-gray-400 uppercase tracking-widest">
                Menu
              </span>
              <button
                type="button"
                onClick={() => setIsDrawerOpen(false)}
                aria-label="Close navigation menu"
                className="p-1 rounded-lg text-gray-400 hover:text-white transition-colors"
              >
                <X size={18} />
              </button>
            </div>

            {/* Primary routes */}
            <Link to="/" className="drawer-link"><Landmark size={16} /> Yield Vaults</Link>
            <Link to="/" className="drawer-link"><Zap size={16} /> Strategies</Link>
            <Link to="/" className="drawer-link"><BarChart3 size={16} /> APY Compare</Link>
            <button
              type="button"
              onClick={() => {
                setIsDrawerOpen(false);
                setIsDiagnosticsOpen(true);
              }}
              className="drawer-link flex items-center gap-2 text-left w-full mt-2 pt-2 border-t border-slate-700/50"
            >
              <Activity size={16} /> System Diagnostics
            </button>
            <Link to="/" className="drawer-link">
              <Landmark size={16} /> Yield Vaults
            </Link>
            <Link to="/" className="drawer-link">
              <Zap size={16} /> Strategies
            </Link>
            <Link to="/" className="drawer-link">
              <BarChart3 size={16} /> APY Compare
            </Link>
          </nav>
        </div>
      )}

      {/* Main Content Area */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 pb-12 animate-in fade-in slide-in-from-bottom-4 duration-700">
        <Outlet />
      </main>
    </div>
  );
};

// Router Configuration
const router = createBrowserRouter([
  {
    path: "/",
    element: <RootLayout />,
    children: [
      {
        path: "/",
        element: <Dashboard />,
      },
      {
        path: "/apy",
        element: (
          <RouteBoundary routeName="analytics">
            <ApyDashboard />
          </RouteBoundary>
        ),
      },
      {
        path: "/ai-advisor",
        element: (
          <RouteBoundary>
            <AIAdvisor />
          </RouteBoundary>
        ),
      },
      {
        path: "/stress",
        element: (
          <RouteBoundary>
            <StressTestDashboard />
          </RouteBoundary>
        ),
      },
      {
        path: "/vault",
        element: (
          <RequireOnboarding require="network">
            <Vault />
          </RequireOnboarding>
        ),
      },
      {
        path: "/vault/:slug",
        element: (
          <RequireOnboarding require="network">
            <Vault />
          </RequireOnboarding>
        ),
      },
      {
        path: "/strategy",
        element: (
          <RouteBoundary>
            <StrategyComparison />
          </RouteBoundary>
        ),
      },
      {
        path: "/strategy/stablecoin-basket",
        element: (
          <RouteBoundary>
            <StablecoinBasketRebalance />
          </RouteBoundary>
        ),
      },
      {
        path: "/strategy/delta-neutral",
        element: (
          <RouteBoundary>
            <DeltaNeutralUnwind />
          </RouteBoundary>
        ),
      },
      {
        path: "/portfolio",
        element: (
          <RouteBoundary>
            <RequireOnboarding require="wallet">
              <PortfolioPage />
            </RequireOnboarding>
          </RouteBoundary>
        ),
      },
      {
        path: "/calculator",
        element: (
          <RouteBoundary>
            <YieldCalculator />
          </RouteBoundary>
        ),
      },
      {
        path: "/planner",
        element: (
          <RouteBoundary>
            <RequireOnboarding require="wallet">
              <GoalPlannerPage />
            </RequireOnboarding>
          </RouteBoundary>
        ),
      },
      {
        path: "/fragmentation",
        element: (
          <RouteBoundary>
            <RequireOnboarding require="wallet">
              <FragmentationDashboard />
            </RequireOnboarding>
          </RouteBoundary>
        ),
      },
      {
        path: "/governance",
        element: (
          <RouteBoundary>
            <RequireOnboarding require="wallet">
              <GovernanceDashboard />
            </RequireOnboarding>
          <RouteBoundary routeName="governance">
            <GovernanceDashboard />
          </RouteBoundary>
        ),
      },
      {
        path: "/quests",
        element: (
          <RouteBoundary>
            <RequireOnboarding require="wallet">
              <QuestsDashboard />
            </RequireOnboarding>
          </RouteBoundary>
        ),
      },
      {
        path: "/leaderboard",
        element: (
          <RouteBoundary>
            <Leaderboard />
          </RouteBoundary>
        ),
      },
      {
        path: "/rewards",
        element: (
          <RouteBoundary>
            <RequireOnboarding require="wallet">
              <ClaimRewards />
            </RequireOnboarding>
          </RouteBoundary>
        ),
      },
      {
        path: "/pnl",
        element: (
          <RouteBoundary>
            <RequireOnboarding require="wallet">
              <PnLChart />
            </RequireOnboarding>
          </RouteBoundary>
        ),
      },
      {
        path: "/taxes",
        element: (
          <RouteBoundary>
            <RequireOnboarding require="wallet">
              <TaxExport />
            </RequireOnboarding>
          </RouteBoundary>
        ),
      },
      {
        path: "/referrals",
        element: (
          <RouteBoundary>
            <RequireOnboarding require="wallet">
              <ReferralDashboard />
            </RequireOnboarding>
          </RouteBoundary>
        ),
      },
      {
        path: "/vesting",
        element: (
          <RouteBoundary>
            <RequireOnboarding require="wallet">
              <VestingDashboard />
            </RequireOnboarding>
          </RouteBoundary>
        ),
      },
      {
        path: "/transparency",
        element: (
          <RouteBoundary routeName="transparency">
            <TransparencyDashboard />
          </RouteBoundary>
        ),
      },
      {
        path: "/transparency/incidents",
        element: (
          <RouteBoundary routeName="transparency">
            <RiskChronology />
          </RouteBoundary>
        ),
      },
      {
        path: "/transparency/relayer",
        element: (
          <RouteBoundary routeName="transparency">
            <RelayerStatusPage />
          </RouteBoundary>
        ),
      },
      {
        path: "/yield-for-good",
        element: (
          <RouteBoundary>
            <YieldForGood />
          </RouteBoundary>
        ),
      },
      {
        path: "/strategy-leaderboard",
        element: (
          <RouteBoundary>
            <StrategyLeaderboard />
          </RouteBoundary>
        ),
      },
      {
        path: "/wallet-session",
        element: (
          <RouteBoundary>
            <RequireOnboarding require="wallet">
              <WalletSessionReview />
            </RequireOnboarding>
          </RouteBoundary>
        ),
      },
      {
        path: "/treasury",
        element: (
          <RouteBoundary>
            <RequireOnboarding require="wallet">
              <TreasurySimulation />
            </RequireOnboarding>
          <RouteBoundary routeName="treasury">
            <TreasurySimulation />
          </RouteBoundary>
        ),
      },
    ],
  },
]);

function App() {
  return (
    <NotificationProvider>
      <RouterProvider router={router} />
    </NotificationProvider>
  );
}

export default App;
