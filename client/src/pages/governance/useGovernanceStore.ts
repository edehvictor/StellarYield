import { useState, useCallback, useMemo } from "react";
import type { PendingTransaction, GovernanceConfig } from "./types";
import type { TxPhase } from "../../services/transactionPhase";
import {
  completeExecutionAttempt,
  failExecutionAttempt,
  GovernanceExecutionError,
  markExecutionSubmitted,
  startExecutionAttempt,
  type GovernanceExecutionState,
} from "./governanceOperation";
import {
  assertGovernanceConfigFingerprint,
  computeGovernanceConfigFingerprint,
  validateGovernanceConfigSnapshot,
} from "../../../../shared/types/governanceConfigSnapshot";
import {
  createSignerRotationAuditRecord,
  type SignerRotationAuditRecord,
} from "./signerRotationAudit";

const STORAGE_KEY = "stellar_yield_governance_txns";
const CONFIG_KEY = "stellar_yield_governance_config";
const SIGNER_ROTATION_AUDIT_KEY = "stellar_yield_signer_rotation_audit";

const VALID_TX_STATUSES = new Set(["pending", "ready", "executed", "expired"]);
const VALID_OP_STATUSES = new Set(["submitting", "polling", "succeeded", "failed"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isValidExecutionState(value: unknown): value is GovernanceExecutionState {
  if (!isRecord(value)) return false;
  return (
    typeof value.status === "string" &&
    VALID_OP_STATUSES.has(value.status) &&
    isNonEmptyString(value.phase) &&
    typeof value.attempt === "number" &&
    Number.isInteger(value.attempt) &&
    value.attempt >= 1 &&
    typeof value.startedAt === "number" &&
    Number.isFinite(value.startedAt) &&
    typeof value.updatedAt === "number" &&
    Number.isFinite(value.updatedAt) &&
    (value.txHash === undefined || isNonEmptyString(value.txHash)) &&
    (value.error === undefined || typeof value.error === "string")
  );
}

export function isValidPendingTransaction(value: unknown): value is PendingTransaction {
  if (!isRecord(value)) return false;
  if (
    !isNonEmptyString(value.id) ||
    typeof value.description !== "string" ||
    !isNonEmptyString(value.method) ||
    !Array.isArray(value.args) ||
    !value.args.every((arg) => typeof arg === "string") ||
    typeof value.xdr !== "string" ||
    !Array.isArray(value.signatures) ||
    !value.signatures.every(
      (sig) =>
        isRecord(sig) &&
        isNonEmptyString(sig.publicKey) &&
        typeof sig.signedAt === "number" &&
        Number.isFinite(sig.signedAt),
    ) ||
    typeof value.threshold !== "number" ||
    !Number.isInteger(value.threshold) ||
    value.threshold < 1 ||
    typeof value.createdAt !== "number" ||
    !Number.isFinite(value.createdAt) ||
    !isNonEmptyString(value.createdBy) ||
    typeof value.status !== "string" ||
    !VALID_TX_STATUSES.has(value.status)
  ) {
    return false;
  }
  if (value.operation !== undefined && !isValidExecutionState(value.operation)) {
    return false;
  }
  if (
    value.configFingerprint !== undefined &&
    !isNonEmptyString(value.configFingerprint)
  ) {
    return false;
  }
  return true;
}

export function parseStoredTransactions(raw: unknown): PendingTransaction[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isValidPendingTransaction);
}

export function parseStoredConfig(
  raw: unknown,
  fallback: GovernanceConfig,
): GovernanceConfig {
  if (!isRecord(raw)) return fallback;
  if (
    !Array.isArray(raw.signers) ||
    !raw.signers.every(isNonEmptyString) ||
    typeof raw.threshold !== "number" ||
    !Number.isInteger(raw.threshold) ||
    raw.threshold < 1 ||
    typeof raw.contractId !== "string"
  ) {
    return fallback;
  }
  return {
    signers: raw.signers.map((s) => s.trim()),
    threshold: raw.threshold,
    contractId: raw.contractId,
  };
}

export function parseStoredAuditRecords(raw: unknown): SignerRotationAuditRecord[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (entry): entry is SignerRotationAuditRecord =>
      isRecord(entry) &&
      isNonEmptyString(entry.id) &&
      isNonEmptyString(entry.timestamp) &&
      isNonEmptyString(entry.actor) &&
      Array.isArray(entry.addedSigners) &&
      Array.isArray(entry.removedSigners) &&
      typeof entry.previousThreshold === "number" &&
      typeof entry.nextThreshold === "number",
  );
}

export function validateGovernanceConfigInput(
  config: GovernanceConfig,
  actor: string,
): void {
  if (!isNonEmptyString(actor)) {
    throw new GovernanceExecutionError(
      "INVALID_INPUT",
      "Actor address is required to update governance configuration.",
      "actor",
    );
  }
  if (!isRecord(config) || !Array.isArray(config.signers) || typeof config.contractId !== "string") {
    throw new GovernanceExecutionError(
      "INVALID_INPUT",
      "Governance configuration is malformed.",
      "config",
    );
  }
  if (config.signers.length === 0 || !config.signers.every(isNonEmptyString)) {
    throw new GovernanceExecutionError(
      "INVALID_INPUT",
      "At least one valid signer address is required.",
      "signers",
    );
  }
  const unique = new Set(config.signers.map((s) => s.trim()));
  if (unique.size !== config.signers.length) {
    throw new GovernanceExecutionError(
      "INVALID_INPUT",
      "Duplicate signer addresses are not allowed.",
      "signers",
    );
  }
  if (
    typeof config.threshold !== "number" ||
    !Number.isInteger(config.threshold) ||
    config.threshold < 1 ||
    config.threshold > config.signers.length
  ) {
    throw new GovernanceExecutionError(
      "INVALID_INPUT",
      "Threshold must be an integer between 1 and the number of signers.",
      "threshold",
    );
  }
}

function loadFromStorage<T>(
  key: string,
  fallback: T,
  parse?: (raw: unknown) => T,
): T {
  try {
    const stored = localStorage.getItem(key);
    if (stored) {
      const parsed: unknown = JSON.parse(stored);
      return parse ? parse(parsed) : (parsed as T);
    }
  } catch {
    // Ignore parse errors
  }
  return fallback;
}

function saveToStorage<T>(key: string, value: T): void {
  localStorage.setItem(key, JSON.stringify(value));
}

const DEFAULT_CONFIG: GovernanceConfig = {
  signers: [],
  threshold: 3,
  contractId: import.meta.env.VITE_CONTRACT_ID ?? "",
};

function configErrorMessage(config: GovernanceConfig): string {
  const validation = validateGovernanceConfigSnapshot(config);
  return validation.issues.map((issue) => `${issue.field}: ${issue.message}`).join("; ");
}

export function useGovernanceStore() {
  const [transactions, setTransactions] = useState<PendingTransaction[]>(() =>
    loadFromStorage(STORAGE_KEY, [], parseStoredTransactions),
  );
  const [config, setConfig] = useState<GovernanceConfig>(() =>
    loadFromStorage(CONFIG_KEY, DEFAULT_CONFIG, (raw) =>
      parseStoredConfig(raw, DEFAULT_CONFIG),
    ),
  );
  const [signerRotationAudit, setSignerRotationAudit] = useState<
    SignerRotationAuditRecord[]
  >(() => loadFromStorage(SIGNER_ROTATION_AUDIT_KEY, [], parseStoredAuditRecords));

  const configFingerprint = useMemo(
    () => computeGovernanceConfigFingerprint(config).fingerprint,
    [config],
  );

  /**
   * Persist first, then publish to React. A storage failure leaves the
   * in-memory proposal and its signatures exactly as they were.
   */
  const commitTransactions = useCallback((next: PendingTransaction[]) => {
    saveToStorage(STORAGE_KEY, next);
    setTransactions(next);
  }, []);

  const updateTransaction = useCallback(
    (
      txId: string,
      update: (transaction: PendingTransaction) => PendingTransaction,
    ): PendingTransaction | null => {
      const target = transactions.find((tx) => tx.id === txId);
      if (!target) return null;

      const updatedTarget = update(target);
      if (updatedTarget === target) return target;

      commitTransactions(
        transactions.map((tx) => (tx.id === txId ? updatedTarget : tx)),
      );
      return updatedTarget;
    },
    [transactions, commitTransactions],
  );

  const addTransaction = useCallback(
    (tx: PendingTransaction) => {
      if (!isValidPendingTransaction(tx)) {
        throw new GovernanceExecutionError(
          "INVALID_INPUT",
          "Proposal transaction payload is malformed.",
          "transaction",
        );
      }
      const boundFingerprint =
        tx.configFingerprint !== undefined
          ? assertGovernanceConfigFingerprint(config, tx.configFingerprint)
          : configFingerprint;
      commitTransactions([
        ...transactions,
        { ...tx, configFingerprint: boundFingerprint },
      ]);
    },
    [transactions, commitTransactions, config, configFingerprint],
  );

  const addSignature = useCallback(
    (txId: string, publicKey: string) => {
      if (!isNonEmptyString(txId)) {
        throw new GovernanceExecutionError(
          "INVALID_INPUT",
          "Transaction id is required.",
          "txId",
        );
      }
      if (!isNonEmptyString(publicKey)) {
        throw new GovernanceExecutionError(
          "INVALID_INPUT",
          "Signer public key is required.",
          "publicKey",
        );
      }
      const normalizedKey = publicKey.trim();
      return updateTransaction(txId, (tx) => {
        if (tx.configFingerprint !== undefined) {
          assertGovernanceConfigFingerprint(config, tx.configFingerprint);
        }
        const alreadySigned = tx.signatures.some((s) => s.publicKey === normalizedKey);
        if (alreadySigned) return tx;

        const newSignatures = [
          ...tx.signatures,
          { publicKey: normalizedKey, signedAt: Date.now() },
        ];
        const newStatus =
          newSignatures.length >= tx.threshold ? "ready" : "pending";

        return { ...tx, signatures: newSignatures, status: newStatus } as PendingTransaction;
      });
    },
    [updateTransaction, config],
  );

  const beginExecution = useCallback(
    (txId: string): GovernanceExecutionState | null => {
      const target = transactions.find((tx) => tx.id === txId);
      if (!target || target.status === "executed") return null;

      if (target.configFingerprint !== undefined) {
        assertGovernanceConfigFingerprint(config, target.configFingerprint);
      }

      if (target.signatures.length < target.threshold) {
        throw new GovernanceExecutionError(
          "PROPOSAL_NOT_READY",
          "This proposal still needs more signatures before it can be executed.",
        );
      }

      const operation = startExecutionAttempt(target.operation);
      commitTransactions(
        transactions.map((tx) =>
          tx.id === txId ? { ...tx, operation } : tx,
        ),
      );
      return operation;
    },
    [transactions, commitTransactions, config],
  );

  const recordExecutionSubmitted = useCallback(
    (txId: string, txHash: string) => {
      if (!isNonEmptyString(txHash)) {
        throw new GovernanceExecutionError(
          "INVALID_INPUT",
          "A non-empty transaction hash is required.",
          "txHash",
        );
      }
      return updateTransaction(txId, (tx) => {
        if (tx.status === "executed") return tx;
        const operation = tx.operation ?? startExecutionAttempt(undefined);
        return {
          ...tx,
          operation: markExecutionSubmitted(operation, txHash.trim()),
        };
      });
    },
    [updateTransaction],
  );

  const failExecution = useCallback(
    (txId: string, error: string, failedAtPhase: TxPhase) => {
      if (!isNonEmptyString(error)) {
        throw new GovernanceExecutionError(
          "INVALID_INPUT",
          "A non-empty failure reason is required.",
          "error",
        );
      }
      return updateTransaction(txId, (tx) => {
        const operation = tx.operation ?? startExecutionAttempt(undefined);
        return {
          ...tx,
          operation: failExecutionAttempt(operation, error, failedAtPhase),
        };
      });
    },
    [updateTransaction],
  );

  const completeExecution = useCallback(
    (txId: string, txHash?: string) => {
      return updateTransaction(txId, (tx) => {
        if (tx.status === "executed") return tx;
        if (tx.configFingerprint !== undefined) {
          assertGovernanceConfigFingerprint(config, tx.configFingerprint);
        }
        return {
          ...tx,
          status: "executed" as const,
          operation: completeExecutionAttempt(tx.operation, txHash),
        };
      });
    },
    [updateTransaction, config],
  );

  const rollbackExecution = useCallback(
    (txId: string) => {
      return updateTransaction(txId, (tx) => {
        if (tx.operation?.status === "succeeded" || tx.status === "executed") {
          throw new GovernanceExecutionError(
            "RESUME_REQUIRED",
            "This proposal already completed and cannot be rolled back.",
          );
        }
        if (tx.operation?.txHash) {
          throw new GovernanceExecutionError(
            "RESUME_REQUIRED",
            "A submitted transaction hash is saved for this proposal. Resume status polling instead of submitting it again.",
          );
        }

        return { ...tx, operation: undefined };
      });
    },
    [updateTransaction],
  );

  const markExecuted = completeExecution;

  const refreshTransactionConfig = useCallback(
    (txId: string) => {
      return updateTransaction(txId, (tx) => {
        if (tx.status === "executed") return tx;
        const allowedSigners = new Set(config.signers);
        const retainedSignatures =
          allowedSigners.size > 0
            ? tx.signatures.filter((sig) => allowedSigners.has(sig.publicKey))
            : tx.signatures;
        const nextThreshold = config.threshold;
        const nextStatus =
          tx.status === "expired"
            ? "expired"
            : retainedSignatures.length >= nextThreshold
              ? "ready"
              : "pending";
        return {
          ...tx,
          configFingerprint,
          threshold: nextThreshold,
          signatures: retainedSignatures,
          status: nextStatus,
        };
      });
    },
    [updateTransaction, config, configFingerprint],
  );

  const updateConfig = useCallback(
    (newConfig: GovernanceConfig, actor: string) => {
      if (!isNonEmptyString(actor)) {
        throw new GovernanceExecutionError(
          "INVALID_INPUT",
          "Actor address is required to update governance configuration.",
          "actor",
        );
      }
      const validation = validateGovernanceConfigSnapshot(newConfig);
      if (!validation.valid) {
        throw new Error(`Invalid governance configuration: ${configErrorMessage(newConfig)}`);
      }

      const normalizedConfig = validation.snapshot;
      const record = createSignerRotationAuditRecord(
        config,
        normalizedConfig,
        actor,
        new Date().toISOString(),
      );
      const updatedAudit = record
        ? [...signerRotationAudit, record]
        : signerRotationAudit;
      let configPersisted = false;

      try {
        saveToStorage(CONFIG_KEY, normalizedConfig);
        configPersisted = true;
        if (record) {
          saveToStorage(SIGNER_ROTATION_AUDIT_KEY, updatedAudit);
        }
      } catch {
        if (configPersisted) {
          try {
            saveToStorage(CONFIG_KEY, config);
          } catch {
            throw new Error(
              "Unable to save the signer audit or restore the previous governance configuration. Reload and verify the saved configuration.",
            );
          }
        }
        throw new Error(
          "Unable to save governance configuration and signer audit. Check browser storage availability and try again.",
        );
      }

      setConfig(normalizedConfig);
      if (record) setSignerRotationAudit(updatedAudit);
    },
    [config, signerRotationAudit],
  );

  return {
    transactions,
    config,
    configFingerprint,
    signerRotationAudit,
    addTransaction,
    addSignature,
    beginExecution,
    recordExecutionSubmitted,
    failExecution,
    completeExecution,
    rollbackExecution,
    markExecuted,
    refreshTransactionConfig,
    updateConfig,
  };
}
