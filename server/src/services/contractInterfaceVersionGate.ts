import {
  assertContractInterfaceVersion,
  CONTRACT_INTERFACE_VERSIONS,
  evaluateContractInterfaceVersion,
  type ContractInterfaceName,
  type ContractInterfaceVersionCheck,
} from "../../../shared/types/contractInterface";

export type ContractInterfaceVersionSource = "env" | "override" | "unknown";

export interface ContractInterfaceVersionGateResult {
  contract: ContractInterfaceName;
  check: ContractInterfaceVersionCheck;
  source: ContractInterfaceVersionSource;
}

const ENV_KEYS: Record<ContractInterfaceName, string> = {
  vault: "VAULT_CONTRACT_INTERFACE_VERSION",
  zap: "ZAP_CONTRACT_INTERFACE_VERSION",
  governance: "GOVERNANCE_CONTRACT_INTERFACE_VERSION",
  strategy: "STRATEGY_CONTRACT_INTERFACE_VERSION",
};

export function getExpectedContractInterfaceVersion(
  contract: ContractInterfaceName,
): string {
  return CONTRACT_INTERFACE_VERSIONS[contract];
}

export function getConfiguredContractInterfaceVersion(
  contract: ContractInterfaceName,
): { version: string | null; source: ContractInterfaceVersionSource } {
  const envKey = ENV_KEYS[contract];
  const value = process.env[envKey];
  if (typeof value === "string" && value.trim().length > 0) {
    return { version: value.trim(), source: "env" };
  }
  return { version: null, source: "unknown" };
}

export function checkContractInterfaceVersion(
  contract: ContractInterfaceName,
  actualVersion?: unknown,
): ContractInterfaceVersionGateResult {
  const configured =
    actualVersion !== undefined
      ? { version: actualVersion, source: "override" as const }
      : getConfiguredContractInterfaceVersion(contract);

  return {
    contract,
    check: evaluateContractInterfaceVersion(
      contract,
      configured.version,
      getExpectedContractInterfaceVersion(contract),
    ),
    source: configured.source,
  };
}

export function assertContractWriteInterfaceVersion(
  contract: ContractInterfaceName,
  actualVersion?: unknown,
): ContractInterfaceVersionGateResult {
  const result = checkContractInterfaceVersion(contract, actualVersion);
  assertContractInterfaceVersion(
    contract,
    result.check.actualVersion,
    result.check.expectedVersion,
  );
  return result;
}
