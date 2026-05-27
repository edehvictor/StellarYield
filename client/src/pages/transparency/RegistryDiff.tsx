import React from 'react';
import registryJson from '../../../../contracts/registry.json';
import prevJson from '../../../../contracts/registry.previous.json';
import StatusBadge from '../../components/StatusBadge';

type ContractName = 'vault'|'zap'|'token'|'governance'|'strategy'|'emissionController'|'liquidStaking'|'stableswap';
type NetworkName = 'testnet'|'mainnet'|'local';

function computeDiff() {
  const networks: NetworkName[] = ['testnet','mainnet','local'];
  const names: ContractName[] = ['vault','zap','token','governance','strategy','emissionController','liquidStaking','stableswap'];
  const result: Record<string, any> = {};

  for (const net of networks) {
    const oldNet = (prevJson as any)[net] ?? {};
    const newNet = (registryJson as any)[net] ?? {};
    result[net] = names.map((n) => {
      const oldAddr = oldNet[n] ?? '';
      const newAddr = newNet[n] ?? '';
      let type: 'unchanged'|'added'|'removed'|'changed' = 'unchanged';
      if ((!oldAddr || oldAddr === '') && (newAddr && newAddr !== '')) type = 'added';
      else if ((oldAddr && oldAddr !== '') && (!newAddr || newAddr === '')) type = 'removed';
      else if ((oldAddr || '') !== (newAddr || '')) type = 'changed';

      return { name: n, oldAddr, newAddr, type };
    });
  }

  return result;
}

const diff = computeDiff();

export default function RegistryDiffPage() {
  return (
    <div className="space-y-6 p-6">
      <h2 className="text-2xl font-bold">Contracts Registry Diff</h2>
      <p className="text-sm text-gray-400">Comparing current `contracts/registry.json` to `contracts/registry.previous.json`.</p>

      {(['testnet','mainnet','local'] as NetworkName[]).map((net) => (
        <div key={net} className="glass-panel p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-semibold capitalize">{net}</h3>
            <div>
              {/* warn if missing required entries */}
              {((registryJson as any)[net] ? Object.values((registryJson as any)[net]).filter((v:string)=>!v || v==='').length : 0) > 0 && (
                <StatusBadge variant="warning" label="Missing entries" />
              )}
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {diff[net].map((c: any) => (
              <div key={c.name} className={`p-3 rounded border ${c.type === 'added' ? 'border-green-500/30 bg-green-500/5' : c.type === 'removed' ? 'border-red-500/30 bg-red-500/5' : c.type === 'changed' ? 'border-yellow-500/30 bg-yellow-500/5' : 'border-white/10 bg-white/3'}`}>
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs text-gray-400">{c.name}</span>
                    <StatusBadge variant={c.type === 'added' ? 'success' : c.type === 'removed' ? 'danger' : c.type === 'changed' ? 'warning' : 'neutral'} label={c.type} compact />
                  </div>
                </div>

                <div className="text-sm text-gray-300 break-all">
                  <div><strong>Old:</strong> {c.oldAddr || <span className="text-gray-500">(empty)</span>}</div>
                  <div><strong>New:</strong> {c.newAddr || <span className="text-gray-500">(empty)</span>}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
