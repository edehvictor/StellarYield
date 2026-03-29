import {
  createBrowserRouter,
  RouterProvider,
  Outlet,
  Link,
} from "react-router-dom";
import Dashboard from "./components/Dashboard";
import ApyDashboard from "./components/dashboard/ApyDashboard";
import AIAdvisor from "./components/AIAdvisor";
import Vault from "./components/Vault";
import PortfolioPage from "./components/portfolio/PortfolioPage";
import GovernanceDashboard from "./pages/governance/GovernanceDashboard";
import QuestsDashboard from "./pages/quests/QuestsDashboard";
import ConnectWalletButton from "./components/wallet/ConnectWalletButton";
import NotificationBell from "./components/Navigation/NotificationBell";
import Leaderboard from "./pages/leaderboard/Leaderboard";
import OnRampModal from "./features/onramp/OnRampModal";
import { useWallet } from "./context/useWallet";
import { useState } from "react";
import {
  LayoutDashboard,
  BarChart3,
  BrainCircuit,
  Landmark,
  PieChart,
  ShieldCheck,
  Trophy,
  CreditCard,
} from "lucide-react";
import "./index.css";

// Layout Component
const RootLayout = () => {
  const { isConnected, walletAddress } = useWallet();
  const [isOnRampOpen, setIsOnRampOpen] = useState(false);

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
      {/* Navigation Bar */}
      <nav className="glass-panel mx-4 mt-6 px-6 py-4 flex justify-between items-center mb-8 sticky top-4 z-50 shadow-2xl">
        <div className="flex items-center gap-3">
          <div className="bg-gradient-to-br from-indigo-500 to-purple-600 w-10 h-10 rounded-full flex items-center justify-center shadow-lg shadow-indigo-500/30">
            <span className="font-bold text-xl tracking-tighter">SY</span>
          </div>
          <h1 className="text-xl font-bold tracking-wide bg-clip-text text-transparent bg-gradient-to-r from-white to-gray-400">
            Stellar Yield
          </h1>
        </div>

        <div className="flex gap-8 items-center text-sm font-medium text-gray-300">
          <Link
            to="/"
            className="hover:text-white transition-colors flex items-center gap-2"
          >
            <LayoutDashboard size={18} /> Dashboard
          </Link>
          <Link
            to="/apy"
            className="hover:text-white transition-colors flex items-center gap-2"
          >
            <BarChart3 size={18} /> APY Compare
          </Link>
          <Link
            to="/ai-advisor"
            className="hover:text-white transition-colors flex items-center gap-2"
          >
            <BrainCircuit size={18} /> AI Advisor
          </Link>
          <Link
            to="/vault"
            className="hover:text-white transition-colors flex items-center gap-2"
          >
            <Landmark size={18} /> Vaults
          </Link>
          {isConnected && (
            <Link
              to="/portfolio"
              className="hover:text-white transition-colors flex items-center gap-2"
            >
              <PieChart size={18} /> Portfolio
            </Link>
          )}
          {isConnected && (
            <Link
              to="/governance"
              className="hover:text-white transition-colors flex items-center gap-2"
            >
              <ShieldCheck size={18} /> Governance
            </Link>
          )}
          <Link
            to="/quests"
            className="hover:text-white transition-colors flex items-center gap-2"
          >
            <Trophy size={18} /> Quests
          </Link>
          <Link
            to="/leaderboard"
            className="hover:text-white transition-colors flex items-center gap-2"
          >
            <Trophy size={18} /> Leaderboard
          </Link>
          {isConnected && (
            <button
              onClick={() => setIsOnRampOpen(true)}
              className="px-4 py-2 bg-indigo-500 hover:bg-indigo-400 text-white rounded-xl text-xs font-black uppercase tracking-widest flex items-center gap-2 transition-all shadow-lg shadow-indigo-500/20 active:scale-95"
            >
              <CreditCard size={14} /> Buy USDC
            </button>
          )}
        </div>

        <div className="flex items-center gap-4">
          <NotificationBell />
          <ConnectWalletButton />
        </div>
      </nav>

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
        element: <ApyDashboard />,
      },
      {
        path: "/ai-advisor",
        element: <AIAdvisor />,
      },
      {
        path: "/vault",
        element: <Vault />,
      },
      {
        path: "/portfolio",
        element: <PortfolioPage />,
      },
      {
        path: "/governance",
        element: <GovernanceDashboard />,
      },
      {
        path: "/quests",
        element: <QuestsDashboard />,
      },
      {
        path: "/leaderboard",
        element: <Leaderboard />,
      },
    ],
  },
]);


function App() {
  return <RouterProvider router={router} />;
}

export default App;
