import type { AttributionReport } from '../services/portfolioAttributionService';
import type { CompatibilityReport, CompatibilityIssue } from '../services/protocolCompatibilityService';
import type { StrategyHealthScore } from '../services/strategyHealthService';
import type { DataSourceReliability } from '../services/yieldReliabilityService';

// ── Interfaces ──────────────────────────────────────────────────────────────

interface ProtocolReport {
  protocols?: Array<{ protocolName: string; status: string; criticalIssues?: number }>;
  issues?: Array<{ severity: string }>;
}

interface ExtendedAttributionReport extends AttributionReport {
  formattedDate?: string;
  totalAttribution?: number;
}

interface ExtendedCompatibilityReport extends CompatibilityReport {
  formattedDate?: string;
  criticalIssues: CompatibilityIssue[];
}

interface ExtendedHealthScore extends StrategyHealthScore {
  status: "healthy" | "degraded" | "critical" | "disabled";
  formattedDate?: string;
}

interface ExtendedReliabilityScore extends DataSourceReliability {
  status: "low" | "medium" | "high" | "unreliable";
  formattedDate?: string;
}

interface WeightedProvider extends DataSourceReliability {
  weight: number;
}

// ── Utility functions ───────────────────────────────────────────────────────

export function validateAttributionRequest(walletAddress: string, startTime: string, endTime: string): { valid: boolean; error?: string } {
  if (!walletAddress || !startTime || !endTime) return { valid: false, error: 'Missing required parameters' };

  const start = new Date(startTime);
  const end = new Date(endTime);

  if (isNaN(start.getTime()) || isNaN(end.getTime())) return { valid: false, error: 'Invalid timestamp format' };
  if (start >= end) return { valid: false, error: 'Start time must be before end time' };

  const maxWindow = 365 * 24 * 60 * 60 * 1000;
  if (end.getTime() - start.getTime() > maxWindow) return { valid: false, error: 'Time window too large (max 1 year)' };

  return { valid: true };
}

export function formatAttributionReport(report: AttributionReport): ExtendedAttributionReport {
  return {
    ...report,
    formattedDate: new Date().toISOString(),
    totalAttribution: report.attributionBreakdown?.reduce((sum, item) => sum + item.contribution, 0) || 0,
  };
}

export function formatCompatibilityReport(report: CompatibilityReport): ExtendedCompatibilityReport {
  return {
    ...report,
    formattedDate: new Date().toISOString(),
    criticalIssues: report.criticalIssues || [],
  };
}

export function formatHealthScore(score: StrategyHealthScore): ExtendedHealthScore {
  const overallScore = score.overallScore;
  return {
    ...score,
    status: overallScore >= 80 ? 'healthy' : overallScore >= 60 ? 'degraded' : 'critical',
    formattedDate: new Date().toISOString(),
  };
}

export function getCriticalHealthAlerts(scores: StrategyHealthScore[]): Array<{
  strategyId: string;
  severity: string;
  message: string;
  timestamp: string;
}> {
  return scores
    .filter(score => score.overallScore < 60)
    .map(score => ({
      strategyId: score.strategyId || 'unknown',
      severity: score.overallScore < 40 ? 'critical' : 'warning',
      message: `Strategy health score: ${score.overallScore}`,
      timestamp: new Date().toISOString(),
    }));
}

export function formatReliabilityScore(reliability: DataSourceReliability): ExtendedReliabilityScore {
  return {
    ...reliability,
    status: reliability.reliabilityScore >= 80 ? 'high' : reliability.reliabilityScore >= 60 ? 'medium' : 'unreliable',
    formattedDate: new Date().toISOString(),
  };
}

export function getWeightedProviderSelection(providers: DataSourceReliability[]): WeightedProvider[] {
  return providers
    .map(provider => ({
      ...provider,
      weight: provider.reliabilityScore / 100,
    }))
    .sort((a, b) => b.weight - a.weight);
}

export function isProtocolSafeForExecution(protocolName: string, report: CompatibilityReport): boolean {
  const protocolStatus = (report as ProtocolReport).protocols?.find(p => p.protocolName === protocolName);
  return protocolStatus?.status === 'compatible' && (protocolStatus?.criticalIssues ?? 0) === 0;
}
