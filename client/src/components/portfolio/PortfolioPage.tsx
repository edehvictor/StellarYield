import { useOutletContext } from "react-router-dom";
import { Wallet } from "lucide-react";
import PortfolioDashboard from "./PortfolioDashboard";

export default function PortfolioPage() {
  const { walletAddress } = useOutletContext<{ walletAddress: string | null }>();

  if (!walletAddress) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center">
        <div className="w-16 h-16 rounded-full bg-[#6C5DD3]/20 flex items-center justify-center mb-4">
          <Wallet size={28} className="text-[#6C5DD3]" />
        </div>
        <h2 className="text-xl font-bold mb-2">Connect Your Wallet</h2>
        <p className="text-gray-400 max-w-md">
          Connect Freighter or spin up a session-managed smart wallet to view
          your portfolio, deposits, yield earnings, and transaction history.
        </p>
      </div>
    );
  }

  return <PortfolioDashboard walletAddress={walletAddress} />;
}
