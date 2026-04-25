import { useEffect } from "react";
import { useParams } from "react-router-dom";
import { Landmark } from "lucide-react";
import { ZapDepositPanel } from "../features/zap";
import { useWallet } from "../context/useWallet";
import { useVaultOgMeta } from "../hooks/useVaultOgMeta";

/**
 * Injects or updates a <meta> tag in document.head.
 * Uses `property` attribute (OG convention) and falls back to `name`.
 */
function setMetaTag(property: string, content: string): void {
  let el =
    document.querySelector<HTMLMetaElement>(`meta[property="${property}"]`) ??
    document.querySelector<HTMLMetaElement>(`meta[name="${property}"]`);

  if (!el) {
    el = document.createElement("meta");
    el.setAttribute("property", property);
    document.head.appendChild(el);
  }
  el.setAttribute("content", content);
}

export default function Vault() {
  const { walletAddress } = useWallet();
  // Support optional /vault/:slug route; fall back to "usdc" as default
  const { slug = "usdc" } = useParams<{ slug?: string }>();

  const meta = useVaultOgMeta(slug);

  // Inject OG + Twitter Card meta tags whenever the vault slug changes
  useEffect(() => {
    const prevTitle = document.title;
    document.title = meta.title;

    for (const { property, content } of meta.tags) {
      setMetaTag(property, content);
    }

    return () => {
      document.title = prevTitle;
    };
  }, [meta]);

  return (
    <div className="flex flex-col items-center min-h-[60vh] text-center space-y-6">
      <div className="bg-green-500/20 p-6 rounded-full inline-block mb-4">
        <Landmark size={64} className="text-green-500" />
      </div>
      <h2 className="text-4xl font-extrabold text-white">Auto-Yield Vaults</h2>
      <p className="text-xl text-gray-400 max-w-2xl mx-auto leading-relaxed">
        Smart contracts on Soroban that automatically rebalance your positions into the
        highest-yielding pools across the Stellar ecosystem.
      </p>

      <div className="glass-panel p-8 mt-8 max-w-3xl w-full text-left">
        <ZapDepositPanel walletAddress={walletAddress} />
      </div>
    </div>
  );
}
