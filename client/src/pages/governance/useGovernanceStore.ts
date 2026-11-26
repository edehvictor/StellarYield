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

function loadFromStorage<T>(key: string, fallback: T): T {
  try {
    const stored = localStorage.getItem(key);
    if (stored) return JSON.parse(stored) as T;
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
    loadFromStorage(STORAGE_KEY, []),
  );
  const [config, setConfig] = useState<GovernanceConfig>(() =>
    loadFromStorage(CONFIG_KEY, DEFAULT_CONFIG),
  );
  const [signerRotationAudit, setSignerRotationAudit] = useState<
    SignerRotationAuditRecord[]
  >(() => loadFromStorage(SIGNER_ROTATION_AUDIT_KEY, []));

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
      commitTransactions([...transactions, tx]);
    },
    [transactions, commitTransactions],
  );

  const addSignature = useCallback(
    (txId: string, publicKey: string) => {
      return updateTransaction(txId, (tx) => {
        const alreadySigned = tx.signatures.some((s) => s.publicKey === publicKey);
        if (alreadySigned) return tx;

        const newSignatures = [
          ...tx.signatures,
          { publicKey, signedAt: Date.now() },
        ];
        const newStatus =
          newSignatures.length >= tx.threshold ? "ready" : "pending";

        return { ...tx, signatures: newSignatures, status: newStatus } as PendingTransaction;
      });
    },
    [updateTransaction],
  );

  const beginExecution = useCallback(
    (txId: string): GovernanceExecutionState | null => {
      const target = transactions.find((tx) => tx.id === txId);
      if (!target || target.status === "executed") return null;

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
    [transactions, commitTransactions],
  );

  const recordExecutionSubmitted = useCallback(
    (txId: string, txHash: string) => {
      return updateTransaction(txId, (tx) => {
        if (tx.status === "executed") return tx;
        const operation = tx.operation ?? startExecutionAttempt(undefined);
        return {
          ...tx,
          operation: markExecutionSubmitted(operation, txHash),
        };
      });
    },
    [updateTransaction],
  );

  const failExecution = useCallback(
    (txId: string, error: string, failedAtPhase: TxPhase) => {
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
        return {
          ...tx,
          status: "executed" as const,
          operation: completeExecutionAttempt(tx.operation, txHash),
        };
      });
    },
    [updateTransaction],
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

  const updateConfig = useCallback(
    (newConfig: GovernanceConfig, actor: string) => {
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
