import { ExternalLink, Github, Mail, Shield, Wallet, X, Zap } from "lucide-react";
import { useState } from "react";
import { useWallet } from "../../context/useWallet";

interface WalletConnectionModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export default function WalletConnectionModal({
  isOpen,
  onClose,
}: WalletConnectionModalProps) {
  const [identifier, setIdentifier] = useState("");
  const {
    connectWallet,
    isConnecting,
    isFreighterInstalled,
    errorMessage,
    verificationStatus,
    clearError,
  } = useWallet();

  if (!isOpen) {
    return null;
  }

  const handleClose = () => {
    clearError();
    onClose();
  };

  const handleConnect = async (
    providerId: "freighter" | "xbull" | "albedo" | "email" | "google" | "github",
  ) => {
    const didConnect = await connectWallet({
      providerId,
      identifier,
    });
    if (didConnect) {
      onClose();
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 px-4 backdrop-blur-sm">
      <div className="glass-panel relative w-full max-w-md p-6 shadow-2xl">
        <button
          type="button"
          onClick={handleClose}
          className="absolute right-4 top-4 text-gray-400 transition-colors hover:text-white"
          aria-label="Close wallet dialog"
        >
          <X size={18} />
        </button>

        <div className="mb-6 flex items-center gap-3">
          <div className="rounded-2xl bg-[#6C5DD3]/20 p-3 text-[#8f81f5]">
            <Wallet size={24} />
          </div>
          <div>
            <p className="text-sm uppercase tracking-[0.2em] text-gray-400">
              Stellar Wallet
            </p>
            <h2 className="text-2xl font-bold text-white">Connect Wallet</h2>
          </div>
        </div>

        <p className="mb-5 text-sm leading-6 text-gray-300">
          Choose a Stellar wallet to connect, or create a session-based smart
          wallet via email or social login.
        </p>

        {errorMessage ? (
          <div className="mb-5 rounded-2xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">
            {errorMessage}
          </div>
        ) : null}

        <div className="space-y-3">
          {/* ── Extension wallets ── */}
          <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
            <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-[#8f81f5]">
              <Wallet size={16} />
              Browser Wallets
            </div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              {isFreighterInstalled === false ? (
                <a
                  href="https://www.freighter.app/"
                  target="_blank"
                  rel="noreferrer"
                  className="btn-secondary col-span-full flex w-full items-center justify-center gap-2 py-3"
                >
                  Install Freighter
                  <ExternalLink size={16} />
                </a>
              ) : (
                <button
                  type="button"
                  onClick={() => void handleConnect("freighter")}
                  disabled={isConnecting}
                  className="btn-primary flex items-center justify-center gap-2 py-3 disabled:cursor-not-allowed disabled:opacity-70"
                >
                  <Wallet size={16} />
                  Freighter
                </button>
              )}
              <button
                type="button"
                onClick={() => void handleConnect("xbull")}
                disabled={isConnecting}
                className="btn-secondary flex items-center justify-center gap-2 py-3 disabled:cursor-not-allowed disabled:opacity-70"
                title="xBull Wallet (opens xBull in-page connector)"
              >
                <Zap size={16} />
                xBull
              </button>
              <button
                type="button"
                onClick={() => void handleConnect("albedo")}
                disabled={isConnecting}
                className="btn-secondary flex items-center justify-center gap-2 py-3 disabled:cursor-not-allowed disabled:opacity-70"
                title="Albedo (opens Albedo popup)"
              >
                <Shield size={16} />
                Albedo
              </button>
            </div>
          </div>

          {/* ── Smart wallet ── */}
          <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
            <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-cyan-200">
              <Shield size={16} />
              Smart Wallet Login
            </div>
            <label className="mb-3 block text-xs uppercase tracking-[0.2em] text-gray-400">
              Email or Social Handle
            </label>
            <input
              type="text"
              value={identifier}
              onChange={(event) => setIdentifier(event.target.value)}
              placeholder="you@example.com or @stellarbuilder"
              className="mb-3 w-full rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-white outline-none transition-colors placeholder:text-gray-500 focus:border-cyan-400"
            />

            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              <button
                type="button"
                onClick={() => void handleConnect("email")}
                disabled={isConnecting}
                className="btn-secondary flex items-center justify-center gap-2 py-3 disabled:cursor-not-allowed disabled:opacity-70"
              >
                <Mail size={16} />
                Email
              </button>
              <button
                type="button"
                onClick={() => void handleConnect("google")}
                disabled={isConnecting}
                className="btn-secondary flex items-center justify-center gap-2 py-3 disabled:cursor-not-allowed disabled:opacity-70"
              >
                <Shield size={16} />
                Google
              </button>
              <button
                type="button"
                onClick={() => void handleConnect("github")}
                disabled={isConnecting}
                className="btn-secondary flex items-center justify-center gap-2 py-3 disabled:cursor-not-allowed disabled:opacity-70"
              >
                <Github size={16} />
                GitHub
              </button>
            </div>
          </div>

          {verificationStatus ? (
            <div className="rounded-2xl border border-white/5 bg-white/5 px-4 py-3 text-xs leading-5 text-gray-400">
              Backend session challenge status:{" "}
              <span className="font-semibold text-white">
                {verificationStatus === "verified"
                  ? "verified"
                  : "local fallback"}
              </span>
              .
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
