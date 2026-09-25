import { useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Loader2,
  Sparkles,
  Shield,
  Scale,
  Zap,
  Clock,
  Droplets,
} from "lucide-react";
import { apiUrl } from "../../lib/api";

export type UserRiskProfile = "conservative" | "balanced" | "aggressive";
export type TimeHorizon = "short" | "medium" | "long";
export type LiquidityNeed = "high" | "medium" | "low";

interface VaultRecommendation {
  rank: number;
  id: string;
  name: string;
  apy: number;
  riskScore: number;
  riskAdjustedYield: number;
  tvlUsd: number;
  ilVolatilityPct: number;
  explanation: string;
  matchScore: number;
}

interface RecommendationResponse {
  summary: string;
  recommendations: VaultRecommendation[];
  recommendation: string;
}

const STEPS = ["Risk Tolerance", "Time Horizon", "Liquidity Needs", "Recommendations"] as const;

const RISK_OPTIONS: { value: UserRiskProfile; label: string; icon: typeof Shield }[] = [
  { value: "conservative", label: "Conservative", icon: Shield },
  { value: "balanced", label: "Balanced", icon: Scale },
  { value: "aggressive", label: "Aggressive", icon: Zap },
];

const HORIZON_OPTIONS: { value: TimeHorizon; label: string; desc: string }[] = [
  { value: "short", label: "Short (< 3 months)", desc: "Prioritize stability and quick access" },
  { value: "medium", label: "Medium (3–12 months)", desc: "Balance yield with moderate risk" },
  { value: "long", label: "Long (12+ months)", desc: "Maximize yield over longer periods" },
];

const LIQUIDITY_OPTIONS: { value: LiquidityNeed; label: string; desc: string }[] = [
  { value: "high", label: "High", desc: "Need to withdraw quickly with deep pools" },
  { value: "medium", label: "Medium", desc: "Occasional withdrawals are fine" },
  { value: "low", label: "Low", desc: "Funds can stay locked for yield" },
];

export default function DepositRecommendationWizard() {
  const [step, setStep] = useState(0);
  const [riskTolerance, setRiskTolerance] = useState<UserRiskProfile>("balanced");
  const [timeHorizon, setTimeHorizon] = useState<TimeHorizon>("medium");
  const [liquidityNeeds, setLiquidityNeeds] = useState<LiquidityNeed>("medium");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<RecommendationResponse | null>(null);

  const canAdvance = step < 3;
  const isLastInputStep = step === 2;

  const fetchRecommendations = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(apiUrl("/api/recommend"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          riskTolerance,
          timeHorizon,
          liquidityNeeds,
          userId: "anonymous",
        }),
      });
      if (!res.ok) throw new Error("Failed to generate recommendations");
      const data = (await res.json()) as RecommendationResponse;
      setResult(data);
      setStep(3);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  };

  const handleNext = () => {
    if (isLastInputStep) {
      void fetchRecommendations();
      return;
    }
    setStep((s) => Math.min(s + 1, STEPS.length - 1));
  };

  const handleBack = () => {
    if (step === 3) {
      setResult(null);
    }
    setStep((s) => Math.max(s - 1, 0));
  };

  return (
    <div className="glass-panel p-6 space-y-6" data-testid="deposit-wizard">
      <div className="flex items-center gap-2">
        <Sparkles className="text-[#6C5DD3]" size={20} />
        <h3 className="text-lg font-semibold text-white">Deposit Recommendation Wizard</h3>
      </div>

      {/* Step indicator */}
      <div className="flex gap-2">
        {STEPS.map((label, idx) => (
          <div
            key={label}
            className={`flex-1 text-center py-2 rounded-lg text-xs font-medium ${
              idx === step
                ? "bg-[#6C5DD3]/30 text-[#6C5DD3] border border-[#6C5DD3]/50"
                : idx < step
                  ? "bg-green-500/10 text-green-400"
                  : "bg-white/5 text-gray-500"
            }`}
          >
            {label}
          </div>
        ))}
      </div>

      {step === 0 && (
        <div className="space-y-3">
          <p className="text-sm text-gray-400">How much risk are you comfortable with?</p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {RISK_OPTIONS.map(({ value, label, icon: Icon }) => (
              <button
                key={value}
                type="button"
                onClick={() => setRiskTolerance(value)}
                className={`p-4 rounded-xl border text-left transition ${
                  riskTolerance === value
                    ? "border-[#6C5DD3] bg-[#6C5DD3]/10"
                    : "border-white/10 bg-white/5 hover:border-white/20"
                }`}
              >
                <Icon size={20} className="text-[#6C5DD3] mb-2" />
                <p className="font-medium text-white">{label}</p>
              </button>
            ))}
          </div>
        </div>
      )}

      {step === 1 && (
        <div className="space-y-3">
          <p className="text-sm text-gray-400 flex items-center gap-2">
            <Clock size={16} /> What is your investment time horizon?
          </p>
          <div className="space-y-2">
            {HORIZON_OPTIONS.map(({ value, label, desc }) => (
              <button
                key={value}
                type="button"
                onClick={() => setTimeHorizon(value)}
                className={`w-full p-4 rounded-xl border text-left transition ${
                  timeHorizon === value
                    ? "border-[#6C5DD3] bg-[#6C5DD3]/10"
                    : "border-white/10 bg-white/5 hover:border-white/20"
                }`}
              >
                <p className="font-medium text-white">{label}</p>
                <p className="text-xs text-gray-400 mt-1">{desc}</p>
              </button>
            ))}
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="space-y-3">
          <p className="text-sm text-gray-400 flex items-center gap-2">
            <Droplets size={16} /> How important is liquidity?
          </p>
          <div className="space-y-2">
            {LIQUIDITY_OPTIONS.map(({ value, label, desc }) => (
              <button
                key={value}
                type="button"
                onClick={() => setLiquidityNeeds(value)}
                className={`w-full p-4 rounded-xl border text-left transition ${
                  liquidityNeeds === value
                    ? "border-[#6C5DD3] bg-[#6C5DD3]/10"
                    : "border-white/10 bg-white/5 hover:border-white/20"
                }`}
              >
                <p className="font-medium text-white">{label}</p>
                <p className="text-xs text-gray-400 mt-1">{desc}</p>
              </button>
            ))}
          </div>
        </div>
      )}

      {step === 3 && result && (
        <div className="space-y-4">
          <p className="text-sm text-gray-300">{result.summary}</p>
          <div className="space-y-3">
            {result.recommendations.map((vault) => (
              <div
                key={vault.id}
                className="rounded-xl border border-white/10 bg-black/20 p-4"
                data-testid={`vault-rec-${vault.id}`}
              >
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold text-[#6C5DD3] bg-[#6C5DD3]/20 px-2 py-0.5 rounded">
                      #{vault.rank}
                    </span>
                    <p className="font-semibold text-white">{vault.name}</p>
                  </div>
                  <span className="text-sm text-green-400 font-medium">
                    {vault.riskAdjustedYield.toFixed(2)}% RAY
                  </span>
                </div>
                <div className="flex gap-4 text-xs text-gray-400 mb-2">
                  <span>APY: {vault.apy.toFixed(2)}%</span>
                  <span>Risk: {vault.riskScore}/10</span>
                  <span>TVL: ${(vault.tvlUsd / 1_000_000).toFixed(1)}M</span>
                </div>
                <p className="text-xs text-gray-400 leading-relaxed">{vault.explanation}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {error && (
        <p className="text-sm text-red-400" role="alert">
          {error}
        </p>
      )}

      <div className="flex justify-between pt-2">
        <button
          type="button"
          onClick={handleBack}
          disabled={step === 0 || loading}
          className="flex items-center gap-1 px-4 py-2 text-sm text-gray-400 hover:text-white disabled:opacity-30"
        >
          <ChevronLeft size={16} /> Back
        </button>

        {canAdvance && (
          <button
            type="button"
            onClick={handleNext}
            disabled={loading}
            className="flex items-center gap-2 px-5 py-2 bg-[#6C5DD3] hover:bg-[#5a4db8] text-white rounded-lg text-sm font-medium disabled:opacity-50"
          >
            {loading ? (
              <>
                <Loader2 size={16} className="animate-spin" /> Analyzing…
              </>
            ) : isLastInputStep ? (
              <>
                Get Recommendations <Sparkles size={16} />
              </>
            ) : (
              <>
                Next <ChevronRight size={16} />
              </>
            )}
          </button>
        )}
      </div>
    </div>
  );
}
