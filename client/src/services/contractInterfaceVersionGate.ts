import {
  assertContractInterfaceVersion,
  CONTRACT_INTERFACE_VERSIONS,
  evaluateContractInterfaceVersion,
  type ContractInterfaceName,
  type ContractInterfaceVersionCheck,
} from "../../../shared/types/contractInterface";

type EnvRecord = Record<string, string | undefined>;

const ENV_KEYS: Record<ContractInterfaceName, string> = {
  vault: "VITE_VAULT_CONTRACT_INTERFACE_VERSION",
  zap: "VITE_ZAP_CONTRACT_INTERFACE_VERSION",
  governance: "VITE_GOVERNANCE_CONTRACT_INTERFACE_VERSION",
  strategy: "VITE_STRATEGY_CONTRACT_INTERFACE_VERSION",
};

function readEnv(): EnvRecord {
  const meta = import.meta as unknown as { env?: EnvRecord };
  return meta.env ?? {};
}

export function getExpectedContractInterfaceVersion(
  contract: ContractInterfaceName,
): string {
  return CONTRACT_INTERFACE_VERSIONS[contract];
}

export function getConfiguredContractInterfaceVersion(
  contract: ContractInterfaceName,
): string | null {
  const value = readEnv()[ENV_KEYS[contract]];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function checkContractInterfaceVersion(
  contract: ContractInterfaceName,
  actualVersion?: unknown,
): ContractInterfaceVersionCheck {
  const version =
    actualVersion !== undefined ? actualVersion : getConfiguredContractInterfaceVersion(contract);
  return evaluateContractInterfaceVersion(
    contract,
    version,
    getExpectedContractInterfaceVersion(contract),
  );
}

export function assertContractWriteInterfaceVersion(
  contract: ContractInterfaceName,
  actualVersion?: unknown,
): ContractInterfaceVersionCheck {
  const check = checkContractInterfaceVersion(contract, actualVersion);
  return assertContractInterfaceVersion(
    contract,
    check.actualVersion,
    check.expectedVersion,
  );
}
