import { useState, useEffect, useCallback } from 'react';
import {
  ShieldCheck,
  AlertTriangle,
  RefreshCw,
  CheckCircle,
  MinusCircle,
  XCircle,
  HelpCircle,
} from 'lucide-react';
import { apiUrl } from '../../lib/api';
import { stableSort } from '../../lib/stableSort';

export type ConfidenceLevel = 'high' | 'reduced' | 'low' | 'unknown';

export type ConfidenceSourceStatus =
  | 'fresh'
  | 'stale'
  | 'failing'
  | 'missing'
  | 'unknown';

export type ConfidenceImpact = 'positive' | 'neutral' | 'negative';

export interface ConfidenceSourceRow {
  provider: string;
  apy: number | null;
  status: ConfidenceSourceStatus;
  isValid: boolean;
  detail: string;
}

export interface ConfidenceFactorRow {
  key: string;
  label: string;
  value: string;
  impact: ConfidenceImpact;
  detail: string;
}

export interface ApyConfidenceExplanationPayload {
  protocol: string;
  level: ConfidenceLevel;
  confidence: number | null;
  forecastApy: number | null;
  quorumMet: boolean;
  summary: string;
  sources: ConfidenceSourceRow[];
  factors: ConfidenceFactorRow[];
}

export interface ApyConfidencePanelProps {
  protocol?: string;
}

const LEVEL_CONFIG: Record<
  ConfidenceLevel,
  { color: string; bg: string; icon: typeof CheckCircle; label: string }
> = {
  high: { color: 'text-green-400', bg: 'bg-green-500/15', icon: CheckCircle, label: 'High confidence' },
  reduced: { color: 'text-yellow-400', bg: 'bg-yellow-500/15', icon: MinusCircle, label: 'Reduced confidence' },
  low: { color: 'text-red-400', bg: 'bg-red-500/15', icon: AlertTriangle, label: 'Low confidence' },
  unknown: { color: 'text-gray-400', bg: 'bg-white/5', icon: HelpCircle, label: 'Unknown confidence' },
};

const SOURCE_STATUS_CONFIG: Record<ConfidenceSourceStatus, { color: string; label: string }> = {
  fresh: { color: 'text-green-400', label: 'Fresh' },
  stale: { color: 'text-yellow-400', label: 'Stale' },
  failing: { color: 'text-red-400', label: 'Failing' },
  missing: { color: 'text-gray-500', label: 'Missing' },
  unknown: { color: 'text-gray-500', label: 'Unknown' },
};

const IMPACT_CONFIG: Record<ConfidenceImpact, { color: string; icon: typeof CheckCircle }> = {
  positive: { color: 'text-green-400', icon: CheckCircle },
  neutral: { color: 'text-gray-400', icon: MinusCircle },
  negative: { color: 'text-red-400', icon: XCircle },
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function normalizeLevel(value: unknown): ConfidenceLevel {
  return value === 'high' || value === 'reduced' || value === 'low' ? value : 'unknown';
}

function normalizeStatus(value: unknown): ConfidenceSourceStatus {
  return value === 'fresh' ||
    value === 'stale' ||
    value === 'failing' ||
    value === 'missing'
    ? value
    : 'unknown';
}

function normalizeImpact(value: unknown): ConfidenceImpact {
  return value === 'positive' || value === 'negative' ? value : 'neutral';
}

function normalizeText(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

function normalizeApy(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Coerce an unknown payload into a typed explanation. Returns null when the
 * payload has no usable explanation shape, so the panel renders its empty
 * state instead of crashing on malformed backend output.
 */
export function normalizeExplanation(input: unknown): ApyConfidenceExplanationPayload | null {
  const root = asRecord(input);
  if (!root) return null;
  const summary = asRecord(root) ? normalizeText(root.summary, '') : '';
  if (summary === '') return null;

  const rawSources = Array.isArray(root.sources) ? root.sources : [];
  const sources: ConfidenceSourceRow[] = rawSources
    .map((item) => asRecord(item))
    .filter((item): item is Record<string, unknown> => item !== null)
    .map((item) => ({
      provider: normalizeText(item.provider, 'unknown-provider'),
      apy: normalizeApy(item.apy),
      status: normalizeStatus(item.status),
      isValid: item.isValid === true,
      detail: normalizeText(item.detail, 'No details available for this source.'),
    }));

  const rawFactors = Array.isArray(root.factors) ? root.factors : [];
  const factors: ConfidenceFactorRow[] = rawFactors
    .map((item) => asRecord(item))
    .filter((item): item is Record<string, unknown> => item !== null)
    .map((item) => ({
      key: normalizeText(item.key, 'factor'),
      label: normalizeText(item.label, 'Factor'),
      value: normalizeText(item.value, 'unknown'),
      impact: normalizeImpact(item.impact),
      detail: normalizeText(item.detail, 'No details available.'),
    }));

  const confidence =
    typeof root.confidence === 'number' && Number.isFinite(root.confidence)
      ? Math.max(0, Math.min(1, root.confidence))
      : null;

  return {
    protocol: normalizeText(root.protocol, 'unknown-protocol'),
    level: normalizeLevel(root.level),
    confidence,
    forecastApy: normalizeApy(root.forecastApy),
    quorumMet: root.quorumMet === true,
    summary,
    sources,
    factors,
  };
}

export function ApyConfidencePanel({ protocol = 'Blend' }: ApyConfidencePanelProps) {
  const [explanation, setExplanation] = useState<ApyConfidenceExplanationPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadExplanation = useCallback(async () => {
    setLoading(true);
    try {
      setError(null);
      const response = await fetch(apiUrl(`/api/yields/predict?protocol=${encodeURIComponent(protocol)}`));
      if (!response.ok) {
        throw new Error(`Forecast endpoint unavailable (${response.status})`);
      }
      const raw = await response.json();
      setExplanation(normalizeExplanation(asRecord(raw)?.explanation ?? null));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load APY confidence details');
      setExplanation(null);
    } finally {
      setLoading(false);
    }
  }, [protocol]);

  useEffect(() => {
    void loadExplanation();
  }, [loadExplanation]);

  if (loading) {
    return (
      <div className="glass-card p-5">
        <div className="flex items-center justify-center py-8">
          <RefreshCw size={24} className="animate-spin text-[#6C5DD3]" />
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="glass-card p-5 border border-red-500/30">
        <div className="flex items-center gap-2 text-red-400">
          <AlertTriangle size={16} />
          <p className="text-sm">{error}</p>
        </div>
        <button
          type="button"
          onClick={() => void loadExplanation()}
          className="mt-3 text-xs px-3 py-1.5 rounded-lg bg-white/5 text-gray-300 hover:bg-white/10"
        >
          Retry
        </button>
      </div>
    );
  }

  if (!explanation) {
    return (
      <div className="glass-card p-5">
        <div className="flex items-center gap-2 text-gray-400">
          <ShieldCheck size={16} />
          <p className="text-sm">No confidence explanation available for {protocol}.</p>
        </div>
      </div>
    );
  }

  const levelConfig = LEVEL_CONFIG[explanation.level] ?? LEVEL_CONFIG.unknown;
  const LevelIcon = levelConfig.icon;

  return (
    <div className="glass-card p-5">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <ShieldCheck size={18} className="text-[#6C5DD3]" />
          <h3 className="text-sm font-semibold uppercase tracking-wider text-gray-400">
            APY Confidence
          </h3>
        </div>
        <span
          className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider flex items-center gap-1 ${levelConfig.bg} ${levelConfig.color}`}
        >
          <LevelIcon size={10} />
          {levelConfig.label}
        </span>
      </div>

      <p className="text-xs text-gray-300 mb-4">{explanation.summary}</p>

      {explanation.sources.length > 0 && (
        <div className="mb-4">
          <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-2">Sources</p>
          <div className="space-y-1.5">
            {stableSort(
              explanation.sources,
              (a, b) => a.provider.localeCompare(b.provider),
              (source) => source.provider,
            ).map((source) => {
              const statusConfig = SOURCE_STATUS_CONFIG[source.status];
              return (
                <div
                  key={source.provider}
                  className="py-2 px-2.5 rounded-lg bg-white/5"
                >
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-gray-300">{source.provider}</span>
                    <div className="flex items-center gap-3">
                      <span className="text-xs font-medium text-white">
                        {source.apy === null ? '—' : `${source.apy.toFixed(2)}%`}
                      </span>
                      <span className={`text-[10px] font-medium uppercase ${statusConfig.color}`}>
                        {statusConfig.label}
                      </span>
                    </div>
                  </div>
                  <p className="text-[11px] text-gray-500 mt-1">{source.detail}</p>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {explanation.factors.length > 0 && (
        <div>
          <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-2">Why this rating</p>
          <div className="space-y-1.5">
            {explanation.factors.map((factor) => {
              const impactConfig = IMPACT_CONFIG[factor.impact];
              const ImpactIcon = impactConfig.icon;
              return (
                <div
                  key={factor.key}
                  className="flex items-start gap-2 py-2 px-2.5 rounded-lg bg-white/5"
                >
                  <ImpactIcon size={12} className={`${impactConfig.color} mt-0.5 shrink-0`} />
                  <div className="min-w-0">
                    <p className="text-xs text-gray-200">
                      {factor.label}
                      <span className="text-gray-500"> · {factor.value}</span>
                    </p>
                    <p className="text-[11px] text-gray-500">{factor.detail}</p>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
