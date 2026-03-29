import { Landmark } from "lucide-react";
import { useParams } from "react-router-dom";
import { useVaultOgMeta } from "../hooks/useVaultOgMeta";

const DEFAULT_VAULT_OG = "StellarYield";

export default function Vault() {
  const { vaultId } = useParams<{ vaultId?: string }>();
  const vault = vaultId ?? DEFAULT_VAULT_OG;
  useVaultOgMeta(vault);

  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] text-center space-y-6">
      <div className="bg-green-500/20 p-6 rounded-full inline-block mb-4">
        <Landmark size={64} className="text-green-500" />
      </div>
      <h2 className="text-4xl font-extrabold text-white">Auto-Yield Vaults</h2>
      <p className="text-xl text-gray-400 max-w-2xl mx-auto leading-relaxed">
        Smart contracts on Soroban that automatically rebalance your positions into the highest-yielding pools across the Stellar ecosystem.
      </p>
      
      <div className="glass-panel p-8 mt-12 max-w-3xl w-full text-left">
        <div className="h-40 border-2 border-dashed border-green-500/30 rounded-xl flex items-center justify-center text-gray-500">
           Coming Soon: Vault Management Module
        </div>
      </div>
    </div>
  );
}
