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

export function formatAttributionReport(report: any): any {
  return {
    ...report,
    formattedDate: new Date().toISOString(),
    totalAttribution: report.breakdown?.reduce((sum: number, item: any) => sum + item.contribution, 0) || 0,
  };
}

export function formatCompatibilityReport(report: any): any {
  return {
    ...report,
    formattedDate: new Date().toISOString(),
    criticalIssues: report.issues?.filter((issue: any) => issue.severity === 'critical') || [],
  };
}

export function formatHealthScore(score: any): any {
  return {
    ...score,
    status: score.overallScore >= 80 ? 'healthy' : score.overallScore >= 60 ? 'degraded' : 'critical',
    formattedDate: new Date().toISOString(),
  };
}

export function getCriticalHealthAlerts(scores: any[]): any[] {
  return scores
    .filter(score => score.overallScore < 60)
    .map(score => ({
      strategyId: score.strategyId,
      severity: score.overallScore < 40 ? 'critical' : 'warning',
      message: `Strategy health score: ${score.overallScore}`,
      timestamp: new Date().toISOString(),
    }));
}

export function formatReliabilityScore(reliability: any): any {
  return {
    ...reliability,
    status: reliability.overallScore >= 80 ? 'reliable' : reliability.overallScore >= 60 ? 'moderate' : 'unreliable',
    formattedDate: new Date().toISOString(),
  };
}

export function getWeightedProviderSelection(providers: any[]): any[] {
  return providers
    .map(provider => ({
      ...provider,
      weight: provider.reliabilityScore / 100, // Simple weighting based on reliability
    }))
    .sort((a, b) => b.weight - a.weight);
}

export function isProtocolSafeForExecution(protocolName: string, report: any): boolean {
  const protocolStatus = report.protocols?.find((p: any) => p.protocolName === protocolName);
  return protocolStatus?.status === 'compatible' && protocolStatus?.criticalIssues === 0;
}
