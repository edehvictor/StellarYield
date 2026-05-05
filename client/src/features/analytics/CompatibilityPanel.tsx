import { useState, useEffect } from "react";
import { Shield, AlertTriangle, CheckCircle, XCircle, RefreshCw, Info, Settings } from "lucide-react";

// ── Types ───────────────────────────────────────────────────────────────

interface CompatibilityIssue {
  severity: 'critical' | 'high' | 'medium' | 'low';
  component: string;
  issue: string;
  impact: string;
  recommendation: string;
  affectedStrategies: string[];
}

interface CompatibilityStatus {
  protocolName: string;
  currentVersion: string;
  latestVersion: string;
  status: 'compatible' | 'degraded' | 'incompatible';
  issues: CompatibilityIssue[];
  lastChecked: string;
  recommendations: string[];
  autoUpdateAvailable: boolean;
}

interface CompatibilityReport {
  overallStatus: 'compatible' | 'degraded' | 'incompatible';
  protocols: CompatibilityStatus[];
  criticalIssues: CompatibilityIssue[];
  generatedAt: string;
  nextCheckDue: string;
}

// ── Configuration ───────────────────────────────────────────────────────

const STATUS_COLORS = {
  compatible: "#3EAC75",
  degraded: "#F5A623", 
  incompatible: "#FF5E5E",
};

const STATUS_ICONS = {
  compatible: <CheckCircle size={16} className="text-[#3EAC75]" />,
  degraded: <AlertTriangle size={16} className="text-[#F5A623]" />,
  incompatible: <XCircle size={16} className="text-[#FF5E5E]" />,
};

const SEVERITY_COLORS = {
  critical: "#FF5E5E",
  high: "#F5A623",
  medium: "#6C5DD3",
  low: "#6B7280",
};

// ── Component ───────────────────────────────────────────────────────────

export default function CompatibilityPanel() {
  const [report, setReport] = useState<CompatibilityReport | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedProtocol, setSelectedProtocol] = useState<CompatibilityStatus | null>(null);

  useEffect(() => {
    fetchCompatibilityReport();
  }, []);

  const fetchCompatibilityReport = async () => {
    try {
      setIsLoading(true);
      setError(null);

      const response = await fetch('/api/analytics/compatibility');

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json();
      setReport(data.data);
      
      // Select first protocol by default
      if (data.data.protocols.length > 0) {
        setSelectedProtocol(data.data.protocols[0]);
      }
    } catch (err) {
      console.error("Failed to fetch compatibility report:", err);
      setError(err instanceof Error ? err.message : "Failed to fetch compatibility report");
    } finally {
      setIsLoading(false);
    }
  };

  const formatDate = (iso: string): string => {
    return new Date(iso).toLocaleString();
  };

  const getSeverityIcon = (severity: string) => {
    switch (severity) {
      case 'critical': return <XCircle size={14} className="text-[#FF5E5E]" />;
      case 'high': return <AlertTriangle size={14} className="text-[#F5A623]" />;
      case 'medium': return <Info size={14} className="text-[#6C5DD3]" />;
      default: return <Info size={14} className="text-gray-400" />;
    }
  };

  if (isLoading) {
    return (
      <div className="glass-panel p-8">
        <div className="flex items-center justify-center py-12">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[#6C5DD3]"></div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="glass-panel p-8">
        <div className="text-center py-12">
          <AlertTriangle className="mx-auto mb-4 text-red-400" size={48} />
          <h3 className="text-lg font-semibold mb-2">Compatibility Data Unavailable</h3>
          <p className="text-gray-400 mb-4">{error}</p>
          <button onClick={fetchCompatibilityReport} className="btn-primary">
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (!report) {
    return (
      <div className="glass-panel p-8">
        <div className="text-center py-12">
          <Shield className="mx-auto mb-4 text-gray-400" size={48} />
          <h3 className="text-lg font-semibold mb-2">No Compatibility Data</h3>
          <p className="text-gray-400">Unable to load compatibility information.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold">Protocol Compatibility Monitor</h2>
          <p className="text-sm text-gray-400 mt-1">
            Monitor protocol upgrade compatibility and detect breaking changes
          </p>
        </div>
        <button onClick={fetchCompatibilityReport} className="btn-secondary flex items-center gap-2">
          <RefreshCw size={14} />
          Refresh
        </button>
      </div>

      {/* Overall Status */}
      <div className="glass-panel p-6">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-lg font-semibold">Overall System Status</h3>
            <p className="text-sm text-gray-400">
              Last checked: {formatDate(report.generatedAt)}
            </p>
          </div>
          <div className="flex items-center gap-3">
            {STATUS_ICONS[report.overallStatus]}
            <span className="text-lg font-bold capitalize" style={{ color: STATUS_COLORS[report.overallStatus] }}>
              {report.overallStatus}
            </span>
          </div>
        </div>

        {report.criticalIssues.length > 0 && (
          <div className="mt-4 p-4 bg-red-500/10 border border-red-500/30 rounded-lg">
            <div className="flex items-center gap-2 mb-2">
              <XCircle size={16} className="text-[#FF5E5E]" />
              <span className="font-semibold text-red-400">
                {report.criticalIssues.length} Critical Issue{report.criticalIssues.length > 1 ? 's' : ''} Found
              </span>
            </div>
            <div className="space-y-1">
              {report.criticalIssues.slice(0, 3).map((issue, index) => (
                <div key={index} className="text-sm text-red-300">
                  • {issue.protocolName}: {issue.issue}
                </div>
              ))}
              {report.criticalIssues.length > 3 && (
                <div className="text-sm text-red-300">
                  • ... and {report.criticalIssues.length - 3} more
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Protocol Status Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {report.protocols.map((protocol) => (
          <div
            key={protocol.protocolName}
            className={`glass-card p-4 cursor-pointer transition-all duration-200 ${
              selectedProtocol?.protocolName === protocol.protocolName ? 'ring-2 ring-[#6C5DD3]' : 'hover:bg-white/5'
            }`}
            onClick={() => setSelectedProtocol(protocol)}
          >
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                {STATUS_ICONS[protocol.status]}
                <span className="text-xs font-semibold uppercase tracking-wider text-gray-400">
                  {protocol.status}
                </span>
              </div>
              {protocol.autoUpdateAvailable && (
                <div className="px-2 py-1 bg-[#6C5DD3]/20 text-[#6C5DD3] text-xs rounded">
                  Update Available
                </div>
              )}
            </div>
            
            <h3 className="font-semibold mb-2">{protocol.protocolName}</h3>
            
            <div className="space-y-1 text-sm">
              <div className="flex justify-between">
                <span className="text-gray-400">Current:</span>
                <span>{protocol.currentVersion}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-400">Latest:</span>
                <span>{protocol.latestVersion}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-400">Issues:</span>
                <span className={protocol.issues.length > 0 ? 'text-[#FF5E5E]' : 'text-[#3EAC75]'}>
                  {protocol.issues.length}
                </span>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Detailed Protocol View */}
      {selectedProtocol && (
        <div className="glass-panel p-6">
          <div className="flex items-center justify-between mb-6">
            <div>
              <h3 className="text-lg font-semibold">{selectedProtocol.protocolName}</h3>
              <p className="text-sm text-gray-400">
                Last checked: {formatDate(selectedProtocol.lastChecked)}
              </p>
            </div>
            <div className="flex items-center gap-3">
              {STATUS_ICONS[selectedProtocol.status]}
              <span className="text-lg font-bold capitalize" style={{ color: STATUS_COLORS[selectedProtocol.status] }}>
                {selectedProtocol.status}
              </span>
            </div>
          </div>

          {/* Version Information */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
            <div>
              <h4 className="font-semibold mb-3">Version Information</h4>
              <div className="space-y-2">
                <div className="flex justify-between items-center p-3 bg-white/5 rounded">
                  <span className="text-gray-400">Current Version</span>
                  <span className="font-mono">{selectedProtocol.currentVersion}</span>
                </div>
                <div className="flex justify-between items-center p-3 bg-white/5 rounded">
                  <span className="text-gray-400">Latest Version</span>
                  <span className="font-mono text-[#3EAC75]">{selectedProtocol.latestVersion}</span>
                </div>
                {selectedProtocol.autoUpdateAvailable && (
                  <div className="flex justify-between items-center p-3 bg-[#6C5DD3]/10 border border-[#6C5DD3]/30 rounded">
                    <span className="text-[#6C5DD3]">Auto-Update Available</span>
                    <button className="btn-primary btn-sm">
                      Update Now
                    </button>
                  </div>
                )}
              </div>
            </div>

            <div>
              <h4 className="font-semibold mb-3">Issue Summary</h4>
              <div className="space-y-2">
                {['critical', 'high', 'medium', 'low'].map((severity) => {
                  const count = selectedProtocol.issues.filter(issue => issue.severity === severity).length;
                  if (count === 0) return null;
                  
                  return (
                    <div key={severity} className="flex justify-between items-center p-3 bg-white/5 rounded">
                      <div className="flex items-center gap-2">
                        {getSeverityIcon(severity)}
                        <span className="capitalize">{severity}</span>
                      </div>
                      <span className="font-semibold" style={{ color: SEVERITY_COLORS[severity as keyof typeof SEVERITY_COLORS] }}>
                        {count}
                      </span>
                    </div>
                  );
                })}
                {selectedProtocol.issues.length === 0 && (
                  <div className="flex justify-between items-center p-3 bg-green-500/10 border border-green-500/30 rounded">
                    <CheckCircle size={16} className="text-[#3EAC75]" />
                    <span className="text-[#3EAC75]">No Issues Detected</span>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Detailed Issues */}
          {selectedProtocol.issues.length > 0 && (
            <div>
              <h4 className="font-semibold mb-3">Detailed Issues</h4>
              <div className="space-y-3">
                {selectedProtocol.issues.map((issue, index) => (
                  <div key={index} className="border border-white/10 rounded-lg p-4">
                    <div className="flex items-start justify-between mb-2">
                      <div className="flex items-center gap-2">
                        {getSeverityIcon(issue.severity)}
                        <span className="font-semibold capitalize">{issue.severity}</span>
                        <span className="text-gray-400">•</span>
                        <span className="text-gray-300">{issue.component}</span>
                      </div>
                    </div>
                    
                    <p className="text-gray-300 mb-2">{issue.issue}</p>
                    <p className="text-sm text-gray-400 mb-3">{issue.impact}</p>
                    
                    <div className="border-t border-white/10 pt-3">
                      <p className="text-sm font-semibold mb-1 text-[#3EAC75]">Recommendation:</p>
                      <p className="text-sm text-gray-300 mb-2">{issue.recommendation}</p>
                      
                      {issue.affectedStrategies.length > 0 && (
                        <div>
                          <p className="text-xs text-gray-400 mb-1">Affected Strategies:</p>
                          <div className="flex flex-wrap gap-1">
                            {issue.affectedStrategies.map((strategy, strategyIndex) => (
                              <span 
                                key={strategyIndex}
                                className="px-2 py-1 bg-white/10 text-xs rounded"
                              >
                                {strategy}
                              </span>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Recommendations */}
          {selectedProtocol.recommendations.length > 0 && (
            <div className="mt-6 border-t border-white/10 pt-6">
              <h4 className="font-semibold mb-3 flex items-center gap-2">
                <Settings size={16} />
                Protocol Recommendations
              </h4>
              <div className="space-y-2">
                {selectedProtocol.recommendations.map((recommendation, index) => (
                  <div key={index} className="flex items-start gap-2 text-sm">
                    <div className="w-2 h-2 rounded-full bg-[#F5A623] mt-1.5 flex-shrink-0" />
                    <span className="text-gray-300">{recommendation}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Footer Info */}
      <div className="text-center text-xs text-gray-400">
        <p>
          Generated on {formatDate(report.generatedAt)} • 
          Next check: {formatDate(report.nextCheckDue)} • 
          {report.protocols.length} protocols monitored
        </p>
      </div>
    </div>
  );
}
