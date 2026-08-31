import { useState, useEffect, useMemo } from "react";
import {
  Shield, AlertTriangle, CheckCircle, XCircle, RefreshCw,
  Info, Settings, ArrowUpDown, Wallet, ArrowLeftRight,
  TrendingUp, BarChart3, DollarSign,
} from "lucide-react";
import StatusBadge from '../../components/StatusBadge';
import { RISK_CHART_COLORS } from "../../components/charts/darkModeContrast";

// ── Types ───────────────────────────────────────────────────────────────

type Severity = 'critical' | 'high' | 'medium' | 'low';
type ActionType = 'deposit' | 'withdraw' | 'rebalance' | 'quote' | 'reporting';
type ActionStatus = 'clear' | 'warning' | 'degraded' | 'blocked';

interface ActionGroup {
  action: ActionType;
  label: string;
  issues: CompatibilityIssue[];
  issueCount: number;
  status: ActionStatus;
}

interface CompatibilityIssue {
  protocolName?: string;
  severity: Severity;
  component: string;
  issue: string;
  impact: string;
  recommendation: string;
  affectedStrategies: string[];
  affectedActions?: ActionType[];
  lastUpdated?: string;
  /** Machine-readable code explaining why the source was downgraded. */
  fallbackReasonCode?: string;
  /** Human-readable sentence explaining the downgrade reason. */
  fallbackReason?: string;
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

interface RegistryWarning {
  code: string;
  message: string;
  network?: string;
  contract?: string;
}

interface CompatibilityReport {
  overallStatus: 'compatible' | 'degraded' | 'incompatible';
  protocols: CompatibilityStatus[];
  criticalIssues: CompatibilityIssue[];
  actionGroups: ActionGroup[];
  generatedAt: string;
  nextCheckDue: string;
  /** Warnings from registry metadata loading — present when data is incomplete. */
  registryWarnings?: RegistryWarning[];
}

// ── Constants ───────────────────────────────────────────────────────────

const ACTIONS: { action: ActionType; label: string; icon: React.ReactNode }[] = [
  { action: 'deposit', label: 'Deposit', icon: <Wallet size={14} /> },
  { action: 'withdraw', label: 'Withdraw', icon: <DollarSign size={14} /> },
  { action: 'rebalance', label: 'Rebalance', icon: <ArrowLeftRight size={14} /> },
  { action: 'quote', label: 'Quote', icon: <TrendingUp size={14} /> },
  { action: 'reporting', label: 'Reporting', icon: <BarChart3 size={14} /> },
];

const STATUS_COLORS: Record<string, string> = {
  compatible:   RISK_CHART_COLORS.healthy,
  degraded:     RISK_CHART_COLORS.degraded,
  incompatible: RISK_CHART_COLORS.critical,
};

const STATUS_ICONS: Record<string, React.ReactNode> = {
  compatible:   <CheckCircle size={16} className="text-[#3EAC75]" />,
  degraded:     <AlertTriangle size={16} className="text-[#F5A623]" />,
  incompatible: <XCircle size={16} className="text-[#FF5E5E]" />,
};

const SEVERITY_COLORS: Record<string, string> = {
  critical: RISK_CHART_COLORS.critical,
  high:     RISK_CHART_COLORS.degraded,
  medium:   RISK_CHART_COLORS.medium,
  low:      RISK_CHART_COLORS.disabled,
};

const SEVERITY_ICONS: Record<string, React.ReactNode> = {
  critical: <XCircle size={14} className="text-[#FF5E5E]" />,
  high:     <AlertTriangle size={14} className="text-[#F5A623]" />,
  medium:   <Info size={14} className="text-[#818CF8]" />,
  low:      <Info size={14} className="text-gray-400" />,
};

const ACTION_STATUS_CONFIG: Record<ActionStatus, { color: string; label: string }> = {
  clear:    { color: RISK_CHART_COLORS.healthy,   label: "All Clear" },
  warning:  { color: RISK_CHART_COLORS.disabled,  label: "Info" },
  degraded: { color: RISK_CHART_COLORS.degraded,  label: "Degraded" },
  blocked:  { color: RISK_CHART_COLORS.critical,  label: "Blocked" },
};

const SEVERITY_ORDER: Severity[] = ['critical', 'high', 'medium', 'low'];

// ── Helpers ─────────────────────────────────────────────────────────────

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString();
}

function sortIssues(issues: CompatibilityIssue[]): CompatibilityIssue[] {
  return [...issues].sort((a, b) => {
    const rankA = SEVERITY_ORDER.indexOf(a.severity);
    const rankB = SEVERITY_ORDER.indexOf(b.severity);
    if (rankA !== rankB) return rankA - rankB;

    const dateA = a.lastUpdated ? new Date(a.lastUpdated).getTime() : 0;
    const dateB = b.lastUpdated ? new Date(b.lastUpdated).getTime() : 0;
    return dateB - dateA;
  });
}

// ── Component ───────────────────────────────────────────────────────────

export default function CompatibilityPanel() {
  const [report, setReport] = useState<CompatibilityReport | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedProtocol, setSelectedProtocol] = useState<CompatibilityStatus | null>(null);
  const [activeAction, setActiveAction] = useState<ActionType>('deposit');

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

  /** Registry warnings surfaced when metadata loading fails or is partial. */
  const registryWarnings = report?.registryWarnings ?? [];

  // Protocol issues grouped by action (used for the protocol detail view)
  const protocolActionGroups = useMemo(() => {
    if (!selectedProtocol) return [];
    const grouped: Record<ActionType, CompatibilityIssue[]> = {
      deposit: [], withdraw: [], rebalance: [], quote: [], reporting: [],
    };
    for (const issue of selectedProtocol.issues) {
      const actions = ((issue.affectedActions?.length ?? 0) > 0
        ? issue.affectedActions
        : ['deposit', 'withdraw', 'rebalance', 'quote', 'reporting']) as ActionType[];
      for (const a of actions) grouped[a].push(issue);
    }
    return (['deposit', 'withdraw', 'rebalance', 'quote', 'reporting'] as ActionType[])
      .map(action => ({ action, issues: sortIssues(grouped[action]) }));
  }, [selectedProtocol]);

  // ── Loading ───────────────────────────────────────────────────────────

  if (isLoading) {
    return (
      <div className="glass-panel p-8">
        <div className="flex items-center justify-center py-12">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[#6C5DD3]" />
        </div>
      </div>
    );
  }

  // ── Error ─────────────────────────────────────────────────────────────

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

  // ── Empty ─────────────────────────────────────────────────────────────

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

  // ── Empty (no protocols) ──────────────────────────────────────────────

  if (report.protocols.length === 0) {
    return (
      <div className="space-y-6">
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
        <div className="glass-panel p-12 text-center">
          <Shield className="mx-auto mb-4 text-gray-400" size={48} />
          <h3 className="text-lg font-semibold mb-2">No Protocols Registered</h3>
          <p className="text-gray-400">Add protocols to begin monitoring compatibility.</p>
        </div>
      </div>
    );
  }

  // ── Active group for the selected action tab ──────────────────────────

  const activeGroup = report.actionGroups.find(g => g.action === activeAction)
    ?? report.actionGroups[0];

  // Sort issues within the active group
  const sortedIssues = sortIssues(activeGroup?.issues ?? []);

  // ── Render ────────────────────────────────────────────────────────────

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

      {/* Registry Warning Banner */}
      {registryWarnings.length > 0 && (
        <div className="glass-panel p-4 border-l-4 border-[#F5A623]">
          <div className="flex items-start gap-3">
            <AlertTriangle size={20} className="text-[#F5A623] flex-shrink-0 mt-0.5" />
            <div className="min-w-0">
              <h4 className="font-semibold text-sm text-[#F5A623]">
                Registry Metadata Incomplete
              </h4>
              <div className="mt-1 space-y-1">
                {registryWarnings.map((w, i) => (
                  <div key={i} className="text-sm text-gray-300">
                    <span className="font-mono text-xs bg-white/10 px-1.5 py-0.5 rounded mr-1">
                      {w.code}
                    </span>
                    {w.message}
                  </div>
                ))}
              </div>
              <p className="text-xs text-gray-500 mt-2">
                Contract views are displaying with fallback data. Resolve the registry issue above to restore full functionality.
              </p>
            </div>
          </div>
        </div>
      )}

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
            <StatusBadge
              variant={report.overallStatus === 'compatible' ? 'success' : report.overallStatus === 'degraded' ? 'warning' : 'danger'}
              label={report.overallStatus}
              compact
            />
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
                  - {issue.protocolName ?? issue.component}: {issue.issue}
                </div>
              ))}
              {report.criticalIssues.length > 3 && (
                <div className="text-sm text-red-300">
                  - ... and {report.criticalIssues.length - 3} more
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Action Group Tabs */}
      <div className="glass-panel p-6">
        <h3 className="text-lg font-semibold mb-4">Issue Impact by Action</h3>
        <div className="flex flex-wrap gap-2 mb-4">
          {ACTIONS.map(({ action, label, icon }) => {
            const group = report.actionGroups.find(g => g.action === action);
            const status = group?.status ?? 'clear';
            const count = group?.issueCount ?? 0;
            const cfg = ACTION_STATUS_CONFIG[status];
            const isActive = action === activeAction;

            return (
              <button
                key={action}
                onClick={() => setActiveAction(action)}
                className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-all cursor-pointer ${
                  isActive
                    ? 'bg-white/10 text-white ring-1 ring-white/20'
                    : 'text-gray-400 hover:text-white hover:bg-white/5'
                }`}
              >
                {icon}
                <span>{label}</span>
                {count > 0 && (
                  <span
                    className="px-1.5 py-0.5 rounded text-xs font-bold"
                    style={{ backgroundColor: cfg.color + '20', color: cfg.color }}
                  >
                    {count}
                  </span>
                )}
                {count === 0 && (
                  <CheckCircle size={12} className="text-[#3EAC75]" />
                )}
              </button>
            );
          })}
        </div>

        {/* Active Action Group Detail */}
        {activeGroup && (
          <div className="border border-white/10 rounded-xl p-4">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <span
                  className="w-2.5 h-2.5 rounded-full"
                  style={{ backgroundColor: ACTION_STATUS_CONFIG[activeGroup.status].color }}
                />
                <h4 className="font-semibold">{activeGroup.label}</h4>
              </div>
              <span
                className="text-xs font-semibold"
                style={{ color: ACTION_STATUS_CONFIG[activeGroup.status].color }}
              >
                {ACTION_STATUS_CONFIG[activeGroup.status].label}
              </span>
            </div>

            {sortedIssues.length === 0 ? (
              <div className="flex items-center gap-2 p-4 bg-green-500/5 border border-green-500/10 rounded-lg">
                <CheckCircle size={16} className="text-[#3EAC75]" />
                <div>
                  <p className="text-sm font-medium text-[#3EAC75]">No Issues</p>
                  <p className="text-xs text-gray-500">
                    All protocols are compatible for {activeGroup.label.toLowerCase()} operations.
                  </p>
                </div>
              </div>
            ) : (
              <div className="space-y-2 max-h-80 overflow-y-auto">
                {sortedIssues.map((issue, idx) => (
                  <div
                    key={idx}
                    className="p-3 bg-white/[0.02] border border-white/5 rounded-lg"
                  >
                    <div className="flex items-start gap-2 mb-1">
                      {SEVERITY_ICONS[issue.severity]}
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 text-sm">
                          <span
                            className="font-semibold capitalize"
                            style={{ color: SEVERITY_COLORS[issue.severity] }}
                          >
                            {issue.severity}
                          </span>
                          {issue.protocolName && (
                            <>
                              <span className="text-gray-500">·</span>
                              <span className="text-gray-300">{issue.protocolName}</span>
                            </>
                          )}
                          <span className="text-gray-500">·</span>
                          <span className="text-gray-400">{issue.component}</span>
                        </div>
                        <p className="text-sm text-gray-300 mt-0.5">{issue.issue}</p>
                        {issue.fallbackReason && (
                          <div className="flex items-center gap-1.5 mt-1.5">
                            <span className="inline-flex items-center px-2 py-0.5 rounded bg-[#6C5DD3]/15 border border-[#6C5DD3]/30 text-[#A78BFA] text-xs font-medium">
                              Fallback reason
                            </span>
                            <span className="text-xs text-gray-400">{issue.fallbackReason}</span>
                          </div>
                        )}
                        {issue.lastUpdated && (
                          <p className="text-xs text-gray-500 mt-1">
                            Updated {formatDate(issue.lastUpdated)}
                          </p>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Action Group Status Summary */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        {ACTIONS.map(({ action, label, icon }) => {
          const group = report.actionGroups.find(g => g.action === action);
          const status = group?.status ?? 'clear';
          const count = group?.issueCount ?? 0;
          const cfg = ACTION_STATUS_CONFIG[status];

          return (
            <button
              key={action}
              onClick={() => setActiveAction(action)}
              className={`glass-card p-3 text-center cursor-pointer transition-all hover:bg-white/5 ${
                activeAction === action ? 'ring-2 ring-[#6C5DD3]' : ''
              }`}
            >
              <div className="flex justify-center mb-1 text-gray-400">{icon}</div>
              <p className="text-xs text-gray-400 mb-0.5">{label}</p>
              {count > 0 ? (
                <p className="text-sm font-bold" style={{ color: cfg.color }}>
                  {count} issue{count !== 1 ? 's' : ''}
                </p>
              ) : (
                <p className="text-xs text-[#3EAC75]">Clear</p>
              )}
              <div
                className="mt-1.5 h-1 rounded-full"
                style={{
                  backgroundColor: cfg.color + '30',
                  width: '100%',
                }}
              >
                <div
                  className="h-1 rounded-full transition-all"
                  style={{
                    backgroundColor: cfg.color,
                    width: count > 0 ? '100%' : '0%',
                  }}
                />
              </div>
            </button>
          );
        })}
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
              <StatusBadge
                variant={selectedProtocol.status === 'compatible' ? 'success' : selectedProtocol.status === 'degraded' ? 'warning' : 'danger'}
                label={selectedProtocol.status}
                compact
              />
              <span
                className="text-lg font-bold capitalize"
                style={{ color: STATUS_COLORS[selectedProtocol.status] }}
              >
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
              <h4 className="font-semibold mb-3">Issue Summary by Severity</h4>
              <div className="space-y-2">
                {SEVERITY_ORDER.map((severity) => {
                  const count = selectedProtocol.issues.filter(issue => issue.severity === severity).length;
                  if (count === 0) return null;

                  return (
                    <div key={severity} className="flex justify-between items-center p-3 bg-white/5 rounded">
                      <div className="flex items-center gap-2">
                        {SEVERITY_ICONS[severity]}
                        <span className="capitalize">{severity}</span>
                      </div>
                      <span className="font-semibold" style={{ color: SEVERITY_COLORS[severity] }}>
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

          {/* Protocol Action Impact */}
          <div className="mb-6">
            <h4 className="font-semibold mb-3">Impact by Action</h4>
            <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
              {protocolActionGroups.map(({ action, issues }) => {
                const ac = ACTIONS.find(a => a.action === action)!;
                const worst = issues.length > 0
                  ? issues.reduce<Severity>((w, i) =>
                      SEVERITY_ORDER.indexOf(i.severity) < SEVERITY_ORDER.indexOf(w)
                        ? i.severity : w,
                      issues[0].severity)
                  : null;
                return (
                  <div
                    key={action}
                    className={`p-3 rounded-lg border text-center ${
                      issues.length === 0
                        ? 'border-green-500/20 bg-green-500/5'
                        : 'border-white/10 bg-white/5'
                    }`}
                  >
                    <div className="flex justify-center mb-1 text-gray-400">{ac.icon}</div>
                    <p className="text-xs text-gray-400 mb-1">{ac.label}</p>
                    {issues.length === 0 ? (
                      <CheckCircle size={14} className="mx-auto text-[#3EAC75]" />
                    ) : worst ? (
                      <span className="text-xs font-bold" style={{ color: SEVERITY_COLORS[worst] }}>
                        {issues.length} issue{issues.length !== 1 ? 's' : ''}
                      </span>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Detailed Issues */}
          {selectedProtocol.issues.length > 0 && (
            <div>
              <h4 className="font-semibold mb-3">Detailed Issues</h4>
              <div className="space-y-3">
                {sortIssues(selectedProtocol.issues).map((issue, index) => (
                  <div key={index} className="border border-white/10 rounded-lg p-4">
                    <div className="flex items-start justify-between mb-2">
                      <div className="flex items-center gap-2">
                        {SEVERITY_ICONS[issue.severity]}
                        <span className="font-semibold capitalize">{issue.severity}</span>
                        <span className="text-gray-400">-</span>
                        <span className="text-gray-300">{issue.component}</span>
                      </div>
                    </div>

                    <p className="text-gray-300 mb-2">{issue.issue}</p>
                    <p className="text-sm text-gray-400 mb-3">{issue.impact}</p>

                    {issue.fallbackReason && (
                      <div className="flex items-start gap-2 mb-3 p-2.5 rounded-lg bg-[#6C5DD3]/10 border border-[#6C5DD3]/25">
                        <span
                          className="flex-shrink-0 px-2 py-0.5 rounded text-xs font-semibold bg-[#6C5DD3]/20 text-[#A78BFA] border border-[#6C5DD3]/30"
                        >
                          Fallback reason
                        </span>
                        <span className="text-sm text-gray-300">{issue.fallbackReason}</span>
                      </div>
                    )}

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

                      {issue.affectedActions && issue.affectedActions.length > 0 && (
                        <div className="mt-2">
                          <p className="text-xs text-gray-400 mb-1">Affected Actions:</p>
                          <div className="flex flex-wrap gap-1">
                            {issue.affectedActions.map((action) => {
                              const ac = ACTIONS.find(a => a.action === action);
                              return (
                                <span
                                  key={action}
                                  className="px-2 py-1 bg-[#6C5DD3]/10 text-[#6C5DD3] text-xs rounded flex items-center gap-1"
                                >
                                  {ac?.icon}
                                  {ac?.label ?? action}
                                </span>
                              );
                            })}
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
          Generated on {formatDate(report.generatedAt)} -
          Next check: {formatDate(report.nextCheckDue)} -
          {report.protocols.length} protocols monitored
        </p>
      </div>
    </div>
  );
}
