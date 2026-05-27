/**
 * DepositWizard – multi-step risk-adjusted deposit recommendation wizard.
 *
 * Steps:
 *   1. Risk tolerance  (conservative / balanced / aggressive)
 *   2. Time horizon    (short / medium / long)
 *   3. Liquidity needs (high / medium / low)
 *   4. Results         (ranked vault recommendations with explanations)
 */
import { useState } from "react";
import { ChevronRight, ChevronLeft, Loader2, ShieldCheck, TrendingUp, Droplets } from "lucide-react";
import { apiUrl } from "../../lib/api";

type Profile = "conservative" | "balanced" | "aggressive";
type TimeHorizon = "short" | "medium" | "long";
type Liquidity = "high" | "medium" | "low";

interface Recommendation {
  rank: number;
  id: string;
  name: string;
  strategyType: string;
  apy: number;
  tvlUsd: number;
  riskScore: number;
  riskAdjustedYield: number;
  ilVolatilityPct: number;
  explanation: string;
}

interface WizardResult {
  profile: string;
  timeHorizon: string;
  liquidity: string;
  recommendations: Recommendation[];
}

const STEP_COUNT = 3;

function OptionButton({
  label,
  description,
  selected,
  onClick,
}: {
  label: string;
  description: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full text-left p-4 rounded-xl border transition-all ${
        selected
          ? "border-[#6C5DD3] bg-[#6C5DD3]/20 text-white"
          : "border-white/10 bg-white/5 text-gray-300 hover:border-[#6C5DD3]/50"
      }`}
    >
      <p className="font-semibold text-sm">{label}</p>
      <p className="text-xs text-gray-400 mt-0.5">{description}</p>
    </button>
  );
}

export default function DepositWizard() {
  const [step, setStep] = useState(0);
  const [profile, setProfile] = useState<Profile>("balanced");
  const [timeHorizon, setTimeHorizon] = useState<TimeHorizon>("medium");
  const [liquidity, setLiquidity] = useState<Liquidity>("medium");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<WizardResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function fetchRecommendations() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(apiUrl("/api/wizard/recommend"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profile, timeHorizon, liquidity }),
      });
      if (!res.ok) throw new Error(`Server error ${res.status}`);
      const data: WizardResult = await res.json();
      setResult(data);
      setStep(STEP_COUNT + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to fetch recommendations.");
    } finally {
      setLoading(false);
    }
  }

  function reset() {
    setStep(0);
    setResult(null);
    setError(null);
  }

  const steps = [
    {
      icon: <ShieldCheck size={20} className="text-[#6C5DD3]" />,
      title: "Risk Tolerance",
      content: (
        <div className="space-y-3">
          {(
            [
              ["conservative", "Conservative", "Prioritise capital preservation. Lower APY, minimal volatility."],
              ["balanced", "Balanced", "Mix of yield and safety. Moderate risk exposure."],
              ["aggressive", "Aggressive", "Maximise yield. Higher volatility and drawdown accepted."],
            ] as [Profile, string, string][]
          ).map(([val, label, desc]) => (
            <OptionButton
              key={val}
              label={label}
              description={desc}
              selected={profile === val}
              onClick={() => setProfile(val)}
            />
          ))}
        </div>
      ),
    },
    {
      icon: <TrendingUp size={20} className="text-[#6C5DD3]" />,
      title: "Time Horizon",
      content: (
        <div className="space-y-3">
          {(
            [
              ["short", "Short (< 1 month)", "Need funds available soon. Prefer high-TVL, liquid vaults."],
              ["medium", "Medium (1–6 months)", "Balanced between flexibility and yield optimisation."],
              ["long", "Long (6+ months)", "Can lock funds for extended periods to maximise compounding."],
            ] as [TimeHorizon, string, string][]
          ).map(([val, label, desc]) => (
            <OptionButton
              key={val}
              label={label}
              description={desc}
              selected={timeHorizon === val}
              onClick={() => setTimeHorizon(val)}
            />
          ))}
        </div>
      ),
    },
    {
      icon: <Droplets size={20} className="text-[#6C5DD3]" />,
      title: "Liquidity Needs",
      content: (
        <div className="space-y-3">
          {(
            [
              ["high", "High", "May need to withdraw at any time. Avoid high-IL vaults."],
              ["medium", "Medium", "Occasional withdrawals expected. Standard liquidity."],
              ["low", "Low", "Comfortable with illiquid positions for better yield."],
            ] as [Liquidity, string, string][]
          ).map(([val, label, desc]) => (
            <OptionButton
              key={val}
              label={label}
              description={desc}
              selected={liquidity === val}
              onClick={() => setLiquidity(val)}
            />
          ))}
        </div>
      ),
    },
  ];

  // Results view
  if (step === STEP_COUNT + 1 && result) {
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-base font-semibold text-white">Top Vault Recommendations</h3>
          <button onClick={reset} className="text-xs text-[#6C5DD3] hover:underline">
            Start over
          </button>
        </div>
        {result.recommendations.map((rec) => (
          <div
            key={rec.id}
            className="rounded-xl border border-white/10 bg-white/5 p-4 space-y-2"
          >
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-[#6C5DD3] uppercase tracking-wider">
                #{rec.rank}
              </span>
              <span className="text-xs text-gray-400">{rec.strategyType}</span>
            </div>
            <p className="text-sm font-semibold text-white">{rec.name}</p>
            <div className="flex gap-4 text-xs text-gray-400">
              <span>APY: <span className="text-green-400 font-medium">{rec.apy.toFixed(2)}%</span></span>
              <span>Risk: <span className="text-white font-medium">{rec.riskScore}/10</span></span>
              <span>RAY: <span className="text-[#6C5DD3] font-medium">{rec.riskAdjustedYield.toFixed(4)}</span></span>
            </div>
            <p className="text-xs text-gray-400 leading-relaxed">{rec.explanation}</p>
          </div>
        ))}
      </div>
    );
  }

  const current = steps[step];

  return (
    <div className="space-y-5">
      {/* Progress */}
      <div className="flex items-center gap-2">
        {steps.map((s, i) => (
          <div key={i} className="flex items-center gap-2">
            <div
              className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold transition-colors ${
                i < step
                  ? "bg-[#6C5DD3] text-white"
                  : i === step
                  ? "border-2 border-[#6C5DD3] text-[#6C5DD3]"
                  : "border border-white/20 text-gray-500"
              }`}
            >
              {i + 1}
            </div>
            {i < steps.length - 1 && (
              <div className={`h-px w-8 ${i < step ? "bg-[#6C5DD3]" : "bg-white/10"}`} />
            )}
          </div>
        ))}
      </div>

      {/* Step header */}
      <div className="flex items-center gap-2">
        {current.icon}
        <h3 className="text-sm font-semibold text-white">{current.title}</h3>
      </div>

      {/* Step content */}
      {current.content}

      {/* Error */}
      {error && <p className="text-xs text-red-400">{error}</p>}

      {/* Navigation */}
      <div className="flex justify-between pt-2">
        <button
          onClick={() => setStep((s) => s - 1)}
          disabled={step === 0}
          className="flex items-center gap-1 text-xs text-gray-400 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed"
        >
          <ChevronLeft size={14} /> Back
        </button>

        {step < STEP_COUNT - 1 ? (
          <button
            onClick={() => setStep((s) => s + 1)}
            className="flex items-center gap-1 text-xs bg-[#6C5DD3] text-white px-4 py-2 rounded-lg hover:bg-[#5a4bc2]"
          >
            Next <ChevronRight size={14} />
          </button>
        ) : (
          <button
            onClick={fetchRecommendations}
            disabled={loading}
            className="flex items-center gap-1 text-xs bg-[#6C5DD3] text-white px-4 py-2 rounded-lg hover:bg-[#5a4bc2] disabled:opacity-60"
          >
            {loading ? <Loader2 size={14} className="animate-spin" /> : null}
            Get Recommendations <ChevronRight size={14} />
          </button>
        )}
      </div>
    </div>
  );
}
