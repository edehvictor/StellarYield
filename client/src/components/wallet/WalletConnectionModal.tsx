import { ExternalLink, Github, Mail, Shield, Wallet, X, Zap } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useWallet } from "../../context/useWallet";

interface WalletConnectionModalProps {
  isOpen: boolean;
  onClose: () => void;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

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

  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  // Restore focus to the element that triggered the modal when it closes.
  const triggerRef = useRef<Element | null>(null);
  useEffect(() => {
    if (isOpen) {
      triggerRef.current = document.activeElement;
    } else {
      const trigger = triggerRef.current;
      if (trigger instanceof HTMLElement) {
        trigger.focus();
      }
      triggerRef.current = null;
    }
  }, [isOpen]);

  // Move focus into the modal when it opens.
  useEffect(() => {
    if (!isOpen) return;
    const frame = requestAnimationFrame(() => {
      const first = dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE)[0];
      first?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [isOpen]);

  // Trap focus inside the modal.
  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === "Escape") {
        handleClose();
        return;
      }
      if (event.key !== "Tab") return;

      const focusable = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [],
      );
      if (focusable.length === 0) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      if (event.shiftKey) {
        if (document.activeElement === first) {
          event.preventDefault();
          last.focus();
        }
      } else {
        if (document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

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
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 px-4 backdrop-blur-sm"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) handleClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={`${titleId}-desc`}
        className="glass-panel relative w-full max-w-md p-6 shadow-2xl"
        onKeyDown={handleKeyDown}
      >
        <button
          type="button"
          onClick={handleClose}
          className="absolute right-4 top-4 text-gray-400 transition-colors hover:text-white"
          aria-label="Close wallet dialog"
        >
          <X size={18} aria-hidden="true" />
        </button>

        <div className="mb-6 flex items-center gap-3">
          <div className="rounded-2xl bg-[#6C5DD3]/20 p-3 text-[#8f81f5]" aria-hidden="true">
            <Wallet size={24} />
          </div>
          <div>
            <p className="text-sm uppercase tracking-[0.2em] text-gray-400">
              Stellar Wallet
            </p>
            <h2 id={titleId} className="text-2xl font-bold text-white">
              Connect Wallet
            </h2>
          </div>
        </div>

        <p id={`${titleId}-desc`} className="mb-5 text-sm leading-6 text-gray-300">
          Choose a Stellar wallet to connect, or create a session-based smart
          wallet via email or social login.
        </p>

        {errorMessage ? (
          <div
            role="alert"
            className="mb-5 rounded-2xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200"
          >
            {errorMessage}
          </div>
        ) : null}

        <div className="space-y-3">
          {/* ── Extension wallets ── */}
          <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
            <div
              className="mb-3 flex items-center gap-2 text-sm font-semibold text-[#8f81f5]"
              aria-hidden="true"
            >
              <Wallet size={16} />
              Browser Wallets
            </div>
            <div
              className="grid grid-cols-1 gap-2 sm:grid-cols-3"
              role="group"
              aria-label="Browser wallet options"
            >
              {isFreighterInstalled === false ? (
                <a
                  href="https://www.freighter.app/"
                  target="_blank"
                  rel="noreferrer"
                  className="btn-secondary col-span-full flex w-full items-center justify-center gap-2 py-3"
                  aria-label="Install Freighter wallet (opens in new tab)"
                >
                  Install Freighter
                  <ExternalLink size={16} aria-hidden="true" />
                </a>
              ) : (
                <button
                  type="button"
                  onClick={() => void handleConnect("freighter")}
                  disabled={isConnecting}
                  className="btn-primary flex items-center justify-center gap-2 py-3 disabled:cursor-not-allowed disabled:opacity-70"
                  aria-label="Connect with Freighter wallet"
                >
                  <Wallet size={16} aria-hidden="true" />
                  Freighter
                </button>
              )}
              <button
                type="button"
                onClick={() => void handleConnect("xbull")}
                disabled={isConnecting}
                className="btn-secondary flex items-center justify-center gap-2 py-3 disabled:cursor-not-allowed disabled:opacity-70"
                aria-label="Connect with xBull wallet"
              >
                <Zap size={16} aria-hidden="true" />
                xBull
              </button>
              <button
                type="button"
                onClick={() => void handleConnect("albedo")}
                disabled={isConnecting}
                className="btn-secondary flex items-center justify-center gap-2 py-3 disabled:cursor-not-allowed disabled:opacity-70"
                aria-label="Connect with Albedo wallet"
              >
                <Shield size={16} aria-hidden="true" />
                Albedo
              </button>
            </div>
          </div>

          {/* ── Smart wallet ── */}
          <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
            <div
              className="mb-3 flex items-center gap-2 text-sm font-semibold text-cyan-200"
              aria-hidden="true"
            >
              <Shield size={16} />
              Smart Wallet Login
            </div>
            <label
              htmlFor="wallet-identifier"
              className="mb-3 block text-xs uppercase tracking-[0.2em] text-gray-400"
            >
              Email or Social Handle
            </label>
            <input
              id="wallet-identifier"
              type="text"
              value={identifier}
              onChange={(event) => setIdentifier(event.target.value)}
              placeholder="you@example.com or @stellarbuilder"
              aria-label="Email address or social handle for smart wallet login"
              className="mb-3 w-full rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-white outline-none transition-colors placeholder:text-gray-500 focus:border-cyan-400"
            />

            <div
              className="grid grid-cols-1 gap-2 sm:grid-cols-3"
              role="group"
              aria-label="Smart wallet login options"
            >
              <button
                type="button"
                onClick={() => void handleConnect("email")}
                disabled={isConnecting}
                className="btn-secondary flex items-center justify-center gap-2 py-3 disabled:cursor-not-allowed disabled:opacity-70"
                aria-label="Sign in with email"
              >
                <Mail size={16} aria-hidden="true" />
                Email
              </button>
              <button
                type="button"
                onClick={() => void handleConnect("google")}
                disabled={isConnecting}
                className="btn-secondary flex items-center justify-center gap-2 py-3 disabled:cursor-not-allowed disabled:opacity-70"
                aria-label="Sign in with Google"
              >
                <Shield size={16} aria-hidden="true" />
                Google
              </button>
              <button
                type="button"
                onClick={() => void handleConnect("github")}
                disabled={isConnecting}
                className="btn-secondary flex items-center justify-center gap-2 py-3 disabled:cursor-not-allowed disabled:opacity-70"
                aria-label="Sign in with GitHub"
              >
                <Github size={16} aria-hidden="true" />
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
