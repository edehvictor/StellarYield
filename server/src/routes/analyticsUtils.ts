import { AttributionReport } from '../services/portfolioAttributionService';
import { CompatibilityReport } from '../services/protocolCompatibilityService';
import { StrategyHealthScore } from '../services/strategyHealthService';
import { DataSourceReliability } from '../services/yieldReliabilityService';

// Analytics Helper Functions
import type { AttributionReport } from '../services/portfolioAttributionService';
import type { CompatibilityReport, CompatibilityIssue } from '../services/protocolCompatibilityService';
import type { StrategyHealthScore } from '../services/strategyHealthService';
import type { DataSourceReliability } from '../services/yieldReliabilityService';

export function validateAttributionRequest(walletAddress: string, startTime: string, endTime: string): { valid: boolean; error?: string } {
  // Basic validation
  if (!walletAddress || !startTime || !endTime) return { valid: false, error: 'Missing required parameters' };
  
  // Validate timestamp format and range
  const start = new Date(startTime);
  const end = new Date(endTime);
  
  if (isNaN(start.getTime()) || isNaN(end.getTime())) return { valid: false, error: 'Invalid timestamp format' };
  if (start >= end) return { valid: false, error: 'Start time must be before end time' };
  
  // Check if time window is reasonable (max 1 year)
  const maxWindow = 365 * 24 * 60 * 60 * 1000; // 1 year in ms
  if (end.getTime() - start.getTime() > maxWindow) return { valid: false, error: 'Time window too large (max 1 year)' };
  
  return { valid: true };
}

interface ProtocolReport {
  protocols?: Array<{ protocolName: string; status: string; criticalIssues?: number }>;
  issues?: Array<{ severity: string }>;
}

export function formatAttributionReport(report: AttributionReport): any {
  return {
    ...report,
    formattedDate: new Date().toISOString(),
    totalAttribution: (report as any).breakdown?.reduce((sum: number, item: { contribution: number }) => sum + item.contribution, 0) || 0,
  };
}

export function formatCompatibilityReport(report: CompatibilityReport): any {
  return {
    ...report,
    formattedDate: new Date().toISOString(),
    criticalIssues: (report as any).issues?.filter((issue: { severity: string }) => issue.severity === 'critical') || [],
  };
}

export function formatHealthScore(score: StrategyHealthScore): any {
  const overallScore = score.overallScore;
// Extended interfaces for utility functions
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
      weight: provider.reliabilityScore / 100, // Simple weighting based on score
    }))
    .sort((a, b) => b.weight - a.weight);
}

export function isProtocolSafeForExecution(protocolName: string, report: CompatibilityReport): boolean {
  const protocolStatus = report.protocols?.find(p => p.protocolName === protocolName);
  return protocolStatus?.status === 'compatible' && (protocolStatus?.issues?.length ?? 0) === 0;
}
