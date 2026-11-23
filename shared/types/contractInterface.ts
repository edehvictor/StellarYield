export const CONTRACT_INTERFACE_VERSIONS = {
  vault: "1",
  zap: "1",
  governance: "1",
  strategy: "1",
} as const;

export type ContractInterfaceName = keyof typeof CONTRACT_INTERFACE_VERSIONS;

export type ContractInterfaceVersionErrorCode =
  | "CONTRACT_INTERFACE_VERSION_MISSING"
  | "CONTRACT_INTERFACE_VERSION_UNSUPPORTED"
  | "CONTRACT_INTERFACE_VERSION_INVALID";

export interface ContractInterfaceVersionCheck {
  contract: ContractInterfaceName;
  expectedVersion: string;
  actualVersion: string | null;
  compatible: boolean;
  code?: ContractInterfaceVersionErrorCode;
  message?: string;
}

export class ContractInterfaceVersionError extends Error {
  public readonly code: ContractInterfaceVersionErrorCode;
  public readonly contract: ContractInterfaceName;
  public readonly expectedVersion: string;
  public readonly actualVersion: string | null;

  constructor(check: ContractInterfaceVersionCheck) {
    super(
      check.message ??
        `Contract interface version check failed for ${check.contract}`,
    );
    this.name = "ContractInterfaceVersionError";
    this.code = check.code ?? "CONTRACT_INTERFACE_VERSION_UNSUPPORTED";
    this.contract = check.contract;
    this.expectedVersion = check.expectedVersion;
    this.actualVersion = check.actualVersion;
  }
}

export function evaluateContractInterfaceVersion(
  contract: ContractInterfaceName,
  actualVersion: unknown,
  expectedVersion: string = CONTRACT_INTERFACE_VERSIONS[contract],
): ContractInterfaceVersionCheck {
  if (actualVersion === null || actualVersion === undefined || actualVersion === "") {
    return {
      contract,
      expectedVersion,
      actualVersion: null,
      compatible: false,
      code: "CONTRACT_INTERFACE_VERSION_MISSING",
      message: `Missing interface version for ${contract}; write blocked until compatibility is verified`,
    };
  }

  const normalized = String(actualVersion).trim();
  if (!/^[0-9]+(\.[0-9]+)?(\.[0-9]+)?$/.test(normalized)) {
    return {
      contract,
      expectedVersion,
      actualVersion: normalized,
      compatible: false,
      code: "CONTRACT_INTERFACE_VERSION_INVALID",
      message: `Invalid interface version "${normalized}" for ${contract}`,
    };
  }

  const actualMajor = normalized.split(".")[0];
  const expectedMajor = expectedVersion.split(".")[0];
  if (actualMajor !== expectedMajor) {
    return {
      contract,
      expectedVersion,
      actualVersion: normalized,
      compatible: false,
      code: "CONTRACT_INTERFACE_VERSION_UNSUPPORTED",
      message: `Unsupported ${contract} interface version ${normalized}; expected major ${expectedMajor}`,
    };
  }

  return {
    contract,
    expectedVersion,
    actualVersion: normalized,
    compatible: true,
  };
}

export function assertContractInterfaceVersion(
  contract: ContractInterfaceName,
  actualVersion: unknown,
  expectedVersion?: string,
): ContractInterfaceVersionCheck {
  const check = evaluateContractInterfaceVersion(contract, actualVersion, expectedVersion);
  if (!check.compatible) {
    throw new ContractInterfaceVersionError(check);
  }
  return check;
}
