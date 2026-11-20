import { useState, useEffect } from "react";
import { Activity } from "lucide-react";
import { getSystemDiagnostics, type DependencyStatus } from "../../lib/config";
import { useWallet } from "../../context/useWallet";

interface DiagnosticsTriggerProps {
  onClick: () => void;
  className?: string;
}

const DOT_COLORS: Record<DependencyStatus, string> = {
  healthy: "bg-emerald-400",
  warning: "bg-amber-400",
  error: "bg-rose-400",
  unconfigured: "bg-slate-400",
};

export default function DiagnosticsTrigger({ onClick, className = "" }: DiagnosticsTriggerProps) {
  const { isConnected, walletAddress } = useWallet();
  const [status, setStatus] = useState<DependencyStatus>("healthy");

  useEffect(() => {
    const diag = getSystemDiagnostics(import.meta.env, { isConnected, address: walletAddress });
    setStatus(diag.overallStatus);
  }, [isConnected, walletAddress]);

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Open system diagnostics"
      title="System Status & Diagnostics"
      className={`relative p-2 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-600 hover:text-slate-900 transition-colors flex items-center justify-center ${className}`}
    >
      <Activity size={16} />
      <span
        className={`absolute top-1 right-1 w-2 h-2 rounded-full ${DOT_COLORS[status]} ring-2 ring-white`}
        aria-hidden="true"
      />
    </button>
  );
}
