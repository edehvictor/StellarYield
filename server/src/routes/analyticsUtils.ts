// Analytics Helper Functions

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

interface AttributionReport {
  breakdown?: Array<{ contribution: number }>;
  [key: string]: unknown;
}

interface CompatibilityReport {
  issues?: Array<{ severity: string }>;
  [key: string]: unknown;
}

interface HealthScore {
  overallScore: number;
  strategyId?: string;
  [key: string]: unknown;
}

interface ReliabilityScore {
  overallScore: number;
  [key: string]: unknown;
}

interface Provider {
  reliabilityScore?: number;
  overallScore?: number;
  [key: string]: unknown;
}

interface ProtocolReport {
  protocols?: Array<{ protocolName: string; status: string; criticalIssues?: number }>;
  [key: string]: unknown;
}

export function formatAttributionReport(report: AttributionReport): AttributionReport {
  return {
    ...report,
    formattedDate: new Date().toISOString(),
    totalAttribution: report.breakdown?.reduce((sum: number, item: { contribution: number }) => sum + item.contribution, 0) || 0,
  };
}

export function formatCompatibilityReport(report: CompatibilityReport): CompatibilityReport {
  return {
    ...report,
    formattedDate: new Date().toISOString(),
    criticalIssues: report.issues?.filter((issue: { severity: string }) => issue.severity === 'critical') || [],
  };
}

export function formatHealthScore(score: HealthScore): HealthScore {
  return {
    ...score,
    status: score.overallScore >= 80 ? 'healthy' : score.overallScore >= 60 ? 'degraded' : 'critical',
    formattedDate: new Date().toISOString(),
  };
}

export function getCriticalHealthAlerts(scores: HealthScore[]): Array<{
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

export function formatReliabilityScore(reliability: ReliabilityScore): ReliabilityScore {
  return {
    ...reliability,
    status: reliability.overallScore >= 80 ? 'reliable' : reliability.overallScore >= 60 ? 'moderate' : 'unreliable',
    formattedDate: new Date().toISOString(),
  };
}

export function getWeightedProviderSelection(providers: Provider[]): Array<Provider & { weight: number }> {
  return providers
    .map(provider => ({
      ...provider,
      weight: (provider.overallScore || provider.reliabilityScore || 0) / 100, // Simple weighting based on score
    }))
    .sort((a, b) => b.weight - a.weight);
}

export function isProtocolSafeForExecution(protocolName: string, report: ProtocolReport): boolean {
  const protocolStatus = report.protocols?.find((p: { protocolName: string; status: string; criticalIssues?: number }) => p.protocolName === protocolName);
  return protocolStatus?.status === 'compatible' && (protocolStatus?.criticalIssues ?? 0) === 0;
}
