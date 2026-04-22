import { Landmark } from "lucide-react";
import { ZapDepositPanel } from "../features/zap";
import { useWallet } from "../context/useWallet";

export default function Vault() {
  const { walletAddress } = useWallet();

  return (
    <div className="flex flex-col items-center min-h-[60vh] text-center space-y-6">
      <div className="bg-green-500/20 p-6 rounded-full inline-block mb-4">
        <Landmark size={64} className="text-green-500" />
      </div>
      <h2 className="text-4xl font-extrabold text-white">Auto-Yield Vaults</h2>
      <p className="text-xl text-gray-400 max-w-2xl mx-auto leading-relaxed">
        Smart contracts on Soroban that automatically rebalance your positions into the highest-yielding pools across the Stellar ecosystem.
      </p>

      <div className="glass-panel p-8 mt-8 max-w-3xl w-full text-left">
        <ZapDepositPanel walletAddress={walletAddress} />
      </div>
    </div>
  );
}
