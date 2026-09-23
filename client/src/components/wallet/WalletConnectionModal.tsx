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
      className="fixed inset-0 z-[60] flex items-center justify-center bg-[#0f172a]/30 px-4 backdrop-blur-md"
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
        className="glass-panel relative w-full max-w-md p-7 shadow-2xl bg-white/90 border border-slate-200/80 rounded-[24px]"
        onKeyDown={handleKeyDown}
      >
        <button
          type="button"
          onClick={handleClose}
          className="absolute right-5 top-5 p-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-400 hover:text-slate-700 transition-all cursor-pointer"
          aria-label="Close wallet dialog"
        >
          <X size={16} aria-hidden="true" />
        </button>

        <div className="mb-6 flex items-center gap-3.5">
          <div className="rounded-2xl bg-[#214fba]/10 p-3 text-[#214fba]" aria-hidden="true">
            <Wallet size={24} />
          </div>
          <div>
            <p className="text-[0.68rem] font-extrabold uppercase tracking-[0.2em] text-[#214fba]/80">
              Stellar Network
            </p>
            <h2 id={titleId} className="text-2xl font-serif font-semibold text-slate-900 italic">
              Connect Wallet
            </h2>
          </div>
        </div>

        <p id={`${titleId}-desc`} className="mb-6 text-sm leading-relaxed text-slate-500 font-medium font-sans">
          Choose a Stellar wallet to connect, or create a session-based smart
          wallet via email or social login.
        </p>

        {errorMessage ? (
          <div
            role="alert"
            className="mb-6 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-xs text-red-700 font-semibold flex items-center gap-2"
          >
            <span className="h-1.5 w-1.5 rounded-full bg-red-500 shrink-0 animate-pulse" />
            <span>{errorMessage}</span>
          </div>
        ) : null}

        <div className="space-y-4">
          {/* ── Extension wallets ── */}
          <div className="rounded-[18px] border border-slate-200/60 bg-slate-50/40 p-4 shadow-sm">
            <div
              className="mb-3 flex items-center gap-2 text-xs font-bold text-slate-400 uppercase tracking-wider"
              aria-hidden="true"
            >
              <Wallet size={14} className="text-[#214fba]" />
              Browser Extension
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
                  className="btn-secondary col-span-full flex w-full items-center justify-center gap-2 py-2.5 text-xs font-semibold rounded-xl cursor-pointer"
                  aria-label="Install Freighter wallet (opens in new tab)"
                >
                  Install Freighter
                  <ExternalLink size={14} aria-hidden="true" />
                </a>
              ) : (
                <button
                  type="button"
                  onClick={() => void handleConnect("freighter")}
                  disabled={isConnecting}
                  aria-label="Connect with Freighter wallet"
                  className="btn-primary flex items-center justify-center gap-2 py-2.5 text-xs font-semibold rounded-xl cursor-pointer disabled:cursor-not-allowed disabled:opacity-70"
                >
                  <Wallet size={14} aria-hidden="true" />
                  Freighter
                </button>
              )}
              <button
                type="button"
                onClick={() => void handleConnect("xbull")}
                disabled={isConnecting}
                aria-label="Connect with xBull wallet"
                className="btn-secondary flex items-center justify-center gap-2 py-2.5 text-xs font-semibold rounded-xl cursor-pointer disabled:cursor-not-allowed disabled:opacity-70"
              >
                <Zap size={14} aria-hidden="true" />
                xBull
              </button>
              <button
                type="button"
                onClick={() => void handleConnect("albedo")}
                disabled={isConnecting}
                aria-label="Connect with Albedo wallet"
                className="btn-secondary flex items-center justify-center gap-2 py-2.5 text-xs font-semibold rounded-xl cursor-pointer disabled:cursor-not-allowed disabled:opacity-70"
              >
                <Shield size={14} aria-hidden="true" />
                Albedo
              </button>
            </div>
          </div>

          {/* ── Smart wallet ── */}
          <div className="rounded-[18px] border border-slate-200/60 bg-slate-50/40 p-4 shadow-sm">
            <div
              className="mb-3 flex items-center gap-2 text-xs font-bold text-slate-400 uppercase tracking-wider"
              aria-hidden="true"
            >
              <Shield size={14} className="text-[#214fba]" />
              Smart Wallet Login
            </div>
            <label
              htmlFor="wallet-identifier"
              className="mb-2 block text-[0.68rem] font-extrabold uppercase tracking-[0.15em] text-slate-400"
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
              className="mb-4 w-full rounded-xl border border-slate-200 bg-white/80 px-4 py-2.5 text-xs text-slate-800 outline-none transition-all placeholder:text-slate-400 focus:border-[#214fba] focus:ring-1 focus:ring-[#214fba]/30 shadow-inner"
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
                className="btn-secondary flex items-center justify-center gap-2 py-2.5 text-xs font-semibold rounded-xl cursor-pointer disabled:cursor-not-allowed disabled:opacity-70"
                aria-label="Sign in with email"
              >
                <Mail size={14} aria-hidden="true" />
                Email
              </button>
              <button
                type="button"
                onClick={() => void handleConnect("google")}
                disabled={isConnecting}
                className="btn-secondary flex items-center justify-center gap-2 py-2.5 text-xs font-semibold rounded-xl cursor-pointer disabled:cursor-not-allowed disabled:opacity-70"
                aria-label="Sign in with Google"
              >
                <Shield size={14} aria-hidden="true" />
                Google
              </button>
              <button
                type="button"
                onClick={() => void handleConnect("github")}
                disabled={isConnecting}
                className="btn-secondary flex items-center justify-center gap-2 py-2.5 text-xs font-semibold rounded-xl cursor-pointer disabled:cursor-not-allowed disabled:opacity-70"
                aria-label="Sign in with GitHub"
              >
                <Github size={14} aria-hidden="true" />
                GitHub
              </button>
            </div>
          </div>

          {verificationStatus ? (
            <div className="rounded-xl border border-slate-200/50 bg-slate-50/30 px-4 py-2.5 text-[0.7rem] leading-normal text-slate-400 font-medium">
              Backend session challenge status:{" "}
              <span className="font-semibold text-slate-600">
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
