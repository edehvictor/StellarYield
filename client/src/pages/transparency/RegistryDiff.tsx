import React, { useMemo, useState } from 'react';
import registryJson from '../../../../contracts/registry.json';
import prevJson from '../../../../contracts/registry.previous.json';
import StatusBadge from '../../components/StatusBadge';

export type ContractName =
  | 'vault'
  | 'zap'
  | 'token'
  | 'governance'
  | 'strategy'
  | 'emissionController'
  | 'liquidStaking'
  | 'stableswap'
  | string;

export type NetworkName = 'testnet' | 'mainnet' | 'local';

export interface RegistryDiffEntry {
  name: string;
  oldAddr: string;
  newAddr: string;
  type: 'unchanged' | 'added' | 'removed' | 'changed';
}

export type RegistryDiffResult = Record<NetworkName, RegistryDiffEntry[]>;

export const KNOWN_CONTRACT_NAMES: string[] = [
  'emissionController',
  'governance',
  'liquidStaking',
  'stableswap',
  'strategy',
  'token',
  'vault',
  'zap',
];

export const NETWORKS: NetworkName[] = ['testnet', 'mainnet', 'local'];

export function computeRegistryDiff(
  current: Record<string, Record<string, string> | undefined> | null | undefined = registryJson,
  previous: Record<string, Record<string, string> | undefined> | null | undefined = prevJson,
): RegistryDiffResult {
  const result: RegistryDiffResult = {
    testnet: [],
    mainnet: [],
    local: [],
  };

  const safeCurrent = (current && typeof current === 'object') ? current : {};
  const safePrevious = (previous && typeof previous === 'object') ? previous : {};

  for (const net of NETWORKS) {
    const oldNet = (safePrevious[net] && typeof safePrevious[net] === 'object') ? safePrevious[net]! : {};
    const newNet = (safeCurrent[net] && typeof safeCurrent[net] === 'object') ? safeCurrent[net]! : {};

    // Collect all unique contract names and sort deterministically
    const allKeys = Array.from(
      new Set([
        ...KNOWN_CONTRACT_NAMES,
        ...Object.keys(oldNet),
        ...Object.keys(newNet),
      ]),
    ).sort((a, b) => a.localeCompare(b));

    result[net] = allKeys.map((n) => {
      const rawOld = oldNet[n];
      const rawNew = newNet[n];
      const oldAddr = typeof rawOld === 'string' ? rawOld.trim() : '';
      const newAddr = typeof rawNew === 'string' ? rawNew.trim() : '';

      let type: 'unchanged' | 'added' | 'removed' | 'changed' = 'unchanged';
      if (!oldAddr && newAddr) {
        type = 'added';
      } else if (oldAddr && !newAddr) {
        type = 'removed';
      } else if (oldAddr !== newAddr) {
        type = 'changed';
      }

      return { name: n, oldAddr, newAddr, type };
    });
  }

  return result;
}

export interface RegistryDiffPageProps {
  currentRegistry?: Record<string, Record<string, string> | undefined> | null;
  previousRegistry?: Record<string, Record<string, string> | undefined> | null;
}

export default function RegistryDiffPage({
  currentRegistry = registryJson,
  previousRegistry = prevJson,
}: RegistryDiffPageProps) {
  const [copyState, setCopyState] = useState<Record<string, "idle" | "copied" | "error">>({});

  const diff = useMemo(
    () => computeRegistryDiff(currentRegistry, previousRegistry),
    [currentRegistry, previousRegistry],
  );

  async function copyAddress(key: string, address: string) {
    if (!address) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(address);
      } else {
        const textarea = document.createElement("textarea");
        textarea.value = address;
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand("copy");
        document.body.removeChild(textarea);
      }
      setCopyState((prev) => ({ ...prev, [key]: "copied" }));
      window.setTimeout(() => {
        setCopyState((prev) => ({ ...prev, [key]: "idle" }));
      }, 1500);
    } catch {
      setCopyState((prev) => ({ ...prev, [key]: "error" }));
    }
  }

  return (
    <div className="space-y-6 p-6">
      <h2 className="text-2xl font-bold">Contracts Registry Diff</h2>
      <p className="text-sm text-gray-400">
        Comparing current `contracts/registry.json` to `contracts/registry.previous.json`.
      </p>

      {NETWORKS.map((net) => {
        const netEntries = diff[net] || [];
        const hasDrift = netEntries.some((c) => c.type !== 'unchanged');
        const activeEntries = netEntries.filter((c) => c.oldAddr || c.newAddr);
        const missingCount = netEntries.filter((c) => !c.newAddr).length;

        return (
          <div key={net} className="glass-panel p-4" data-testid={`network-panel-${net}`}>
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-3">
                <h3 className="font-semibold capitalize">{net}</h3>
                {hasDrift ? (
                  <StatusBadge variant="warning" label="Drift Detected" compact />
                ) : (
                  <StatusBadge variant="success" label="In Sync" compact />
                )}
              </div>
              <div className="flex items-center gap-2">
                {missingCount > 0 && (
                  <StatusBadge variant="neutral" label={`${missingCount} unconfigured`} compact />
                )}
              </div>
            </div>

            {netEntries.length === 0 ? (
              <div className="text-sm text-gray-500 py-4 text-center">
                No registry data available for {net}.
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {netEntries.map((c) => (
                  <div
                    key={c.name}
                    data-testid={`diff-entry-${net}-${c.name}`}
                    className={`p-3 rounded border transition-colors ${
                      c.type === 'added'
                        ? 'border-green-500/30 bg-green-500/5'
                        : c.type === 'removed'
                        ? 'border-red-500/30 bg-red-500/5'
                        : c.type === 'changed'
                        ? 'border-yellow-500/30 bg-yellow-500/5'
                        : 'border-white/10 bg-white/3'
                    }`}
                  >
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-xs text-gray-400">{c.name}</span>
                        <StatusBadge
                          variant={
                            c.type === 'added'
                              ? 'success'
                              : c.type === 'removed'
                              ? 'danger'
                              : c.type === 'changed'
                              ? 'warning'
                              : 'neutral'
                          }
                          label={c.type}
                          compact
                        />
                      </div>
                    </div>

                    <div className="text-sm text-gray-300 break-all space-y-1">
                      <div>
                        <strong>Network:</strong> {net}
                      </div>
                      <div>
                        <strong>Contract type:</strong> {c.name}
                      </div>
                      <div>
                        <strong>Old:</strong>{' '}
                        {c.oldAddr ? (
                          <span className="font-mono text-xs">{c.oldAddr}</span>
                        ) : (
                          <span className="text-gray-500 italic">(empty)</span>
                        )}
                      </div>
                      <div className="flex items-start gap-2">
                        <div className="flex-1">
                          <strong>New:</strong>{' '}
                          {c.newAddr ? (
                            <span className="font-mono text-xs">{c.newAddr}</span>
                          ) : (
                            <span className="text-gray-500 italic">(empty)</span>
                          )}
                        </div>
                        {c.newAddr && (
                          <button
                            type="button"
                            onClick={() => copyAddress(`${net}-${c.name}`, c.newAddr)}
                            className="rounded px-2 py-1 text-xs border border-white/20 hover:border-indigo-400 text-gray-200 cursor-pointer"
                          >
                            Copy
                          </button>
                        )}
                      </div>
                      {copyState[`${net}-${c.name}`] === "copied" && (
                        <p className="text-xs text-green-300 mt-1">Copied!</p>
                      )}
                      {copyState[`${net}-${c.name}`] === "error" && (
                        <p className="text-xs text-red-300 mt-1">Copy failed</p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
