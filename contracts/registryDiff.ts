export type ContractName =
  | "vault"
  | "zap"
  | "token"
  | "governance"
  | "strategy"
  | "emissionController"
  | "liquidStaking"
  | "stableswap";

export type NetworkName = "testnet" | "mainnet" | "local";

export type Registry = Record<NetworkName, Record<ContractName, string>>;

export type ContractChange = {
  name: ContractName;
  oldAddress: string | null;
  newAddress: string | null;
  type: "added" | "removed" | "changed" | "unchanged";
};

export type RegistryDiff = Record<NetworkName, {
  changes: ContractChange[];
  missing: ContractName[]; // required but empty in new registry
}>;

export function diffRegistries(oldReg: Registry, newReg: Registry): RegistryDiff {
  const networks: NetworkName[] = ["testnet", "mainnet", "local"];
  const contractNames: ContractName[] = ["vault","zap","token","governance","strategy","emissionController","liquidStaking","stableswap"];

  const result = {} as RegistryDiff;

  for (const net of networks) {
    const oldNet = oldReg[net] ?? ({} as Record<ContractName, string>);
    const newNet = newReg[net] ?? ({} as Record<ContractName, string>);

    const changes: ContractChange[] = [];
    const missing: ContractName[] = [];

    for (const name of contractNames) {
      const oldAddr = oldNet[name] ?? "";
      const newAddr = newNet[name] ?? "";

      if ((!oldAddr || oldAddr === "") && (newAddr && newAddr !== "")) {
        changes.push({ name, oldAddress: oldAddr || null, newAddress: newAddr || null, type: 'added' });
      } else if ((oldAddr && oldAddr !== "") && (!newAddr || newAddr === "")) {
        changes.push({ name, oldAddress: oldAddr || null, newAddress: newAddr || null, type: 'removed' });
      } else if ((oldAddr || "") !== (newAddr || "")) {
        changes.push({ name, oldAddress: oldAddr || null, newAddress: newAddr || null, type: 'changed' });
      } else {
        changes.push({ name, oldAddress: oldAddr || null, newAddress: newAddr || null, type: 'unchanged' });
      }

      if (!newAddr || newAddr === "") {
        missing.push(name);
      }
    }

    result[net] = { changes, missing };
  }

  return result;
}

/** Per-network human-readable annotation for CI consumers and maintainers. */
export type NetworkAnnotation = {
  network: NetworkName;
  /** Summary line surfaced in CI output. */
  summary: string;
  /** One annotation line per non-unchanged entry. */
  lines: string[];
  /** True when any unexpected drift (added, removed, or changed) is present. */
  hasDrift: boolean;
};

/**
 * Converts a `RegistryDiff` into per-network human-readable annotations.
 * Designed for CI consumers: each `NetworkAnnotation` carries a `hasDrift`
 * flag so a pipeline can fail fast on unexpected contract ID changes.
 *
 * @param diff - Output of `diffRegistries`.
 * @returns An array of one annotation per network, ordered testnet → mainnet → local.
 */
export function annotateRegistryDiff(diff: RegistryDiff): NetworkAnnotation[] {
  const networks: NetworkName[] = ["testnet", "mainnet", "local"];
  return networks.map((network) => {
    const { changes } = diff[network];
    const lines: string[] = [];

    for (const change of changes) {
      if (change.type === "unchanged") continue;
      switch (change.type) {
        case "added":
          lines.push(`[ADDED]   ${change.name}: (none) → ${change.newAddress}`);
          break;
        case "removed":
          // Was previously deployed but is now absent — flag as MISSING in new registry.
          lines.push(`[REMOVED] ${change.name}: ${change.oldAddress} → (none) [MISSING in new registry]`);
          break;
        case "changed":
          lines.push(`[CHANGED] ${change.name}: ${change.oldAddress} → ${change.newAddress}`);
          break;
      }
    }

    const hasDrift = lines.length > 0;
    const summary = hasDrift
      ? `${network}: ${lines.length} change(s) detected`
      : `${network}: no drift`;

    return { network, summary, lines, hasDrift };
  });
}

export default diffRegistries;
