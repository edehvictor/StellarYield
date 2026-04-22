import { useState } from "react";
import { Cpu, Loader2, LogOut, Wallet } from "lucide-react";
import { useWallet } from "../../context/useWallet";
import WalletConnectionModal from "./WalletConnectionModal";

function truncateKey(key: string) {
  return `${key.slice(0, 4)}...${key.slice(-4)}`;
}

export default function ConnectWalletButton() {
  const {
    walletAddress,
    walletAddressType,
    providerLabel,
    isConnected,
    isConnecting,
    disconnectWallet,
  } = useWallet();
  const [isModalOpen, setIsModalOpen] = useState(false);

  if (isConnected && walletAddress) {
    return (
      <button
        type="button"
        onClick={disconnectWallet}
        className="glass-card flex items-center gap-2 border-[#6C5DD3]/50 px-4 py-2 transition-colors hover:border-red-500/50"
        title="Disconnect wallet"
      >
        <span className="h-2 w-2 rounded-full bg-green-500" />
        <span>
          {providerLabel === "Freighter" ? "Freighter" : "Smart Wallet"}{" "}
          {truncateKey(walletAddress)}
        </span>
        {walletAddressType === "contract" ? (
          <Cpu size={14} className="text-cyan-300" />
        ) : null}
        <LogOut size={14} className="text-red-400" />
      </button>
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setIsModalOpen(true)}
        className="btn-primary flex items-center gap-2 disabled:cursor-not-allowed disabled:opacity-70"
        disabled={isConnecting}
      >
        {isConnecting ? (
          <Loader2 size={18} className="animate-spin" />
        ) : (
          <Wallet size={18} />
        )}
        {isConnecting ? "Connecting..." : "Connect Wallet"}
      </button>
      <WalletConnectionModal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
      />
    </>
  );
}
