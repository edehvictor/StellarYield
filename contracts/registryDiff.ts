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

export default diffRegistries;
