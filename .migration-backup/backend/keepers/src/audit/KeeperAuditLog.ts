import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { redactSensitive } from './redact';

/**
 * Tamper-evident, hash-chained audit trail for keeper decisions.
 *
 * Each worker "stream" (e.g. `compound`, `liquidation`) gets its own
 * append-only JSONL file. Every record embeds the SHA-256 hash of the
 * previous record in that stream (`previousHash`) plus its own content hash
 * (`hash`) and an HMAC `signature` over that hash — mutating, reordering, or
 * deleting a historical record breaks the chain for everything after it,
 * which `verifyStreamIntegrity` detects. This mirrors the hash-chain
 * algorithm already used for admin-action audit logs in
 * `server/src/middleware/audit.ts`, adapted for keeper decision records and
 * extended with a monotonic `seq` field so reordering/missing records (which
 * that admin-log variant doesn't need to detect) are also caught here.
 *
 * Persisted as local JSONL files (no DB dependency) since keepers has no
 * database client today and cross-service querying isn't required by the
 * issue this satisfies.
 */

export interface KeeperTxOutcome {
  status: 'success' | 'failure';
  hash?: string;
  error?: string;
}

export interface KeeperDecisionInput {
  workerName: string;
  jobId?: string;
  policyVersion: string;
  contractId: string;
  method: string;
  inputs?: unknown;
  decision: string;
  simulationResult?: unknown;
  txOutcome?: KeeperTxOutcome;
}

export interface KeeperDecisionRecord extends KeeperDecisionInput {
  id: string;
  seq: number;
  timestamp: string;
  stream: string;
  previousHash: string;
  hash: string;
  signature: string;
}

export type IntegrityFailureReason =
  | 'hash-mismatch'
  | 'signature-mismatch'
  | 'chain-break'
  | 'sequence-gap'
  | 'sequence-reordered';

export interface IntegrityResult {
  isValid: boolean;
  brokenAtIndex: number | null;
  reason?: IntegrityFailureReason;
}

const GENESIS_HASH = crypto.createHash('sha256').update('GENESIS').digest('hex');

function generateHash(entry: Omit<KeeperDecisionRecord, 'hash' | 'signature'>): string {
  const data = JSON.stringify({
    id: entry.id,
    seq: entry.seq,
    timestamp: entry.timestamp,
    stream: entry.stream,
    workerName: entry.workerName,
    jobId: entry.jobId ?? null,
    policyVersion: entry.policyVersion,
    contractId: entry.contractId,
    method: entry.method,
    inputs: entry.inputs ?? null,
    decision: entry.decision,
    simulationResult: entry.simulationResult ?? null,
    txOutcome: entry.txOutcome ?? null,
    previousHash: entry.previousHash,
  });
  return crypto.createHash('sha256').update(data).digest('hex');
}

function generateSignature(hash: string, signingKey?: string): string {
  const key = signingKey ?? process.env.KEEPER_AUDIT_SIGNING_KEY ?? process.env.AUDIT_SIGNING_KEY ?? 'default-key';
  return crypto.createHmac('sha256', key).update(hash).digest('hex');
}

function verifyRecord(record: KeeperDecisionRecord): { hashOk: boolean; signatureOk: boolean } {
  const { hash, signature, ...rest } = record;
  const expectedHash = generateHash(rest as Omit<KeeperDecisionRecord, 'hash' | 'signature'>);
  const expectedSignature = generateSignature(expectedHash);
  return {
    hashOk: expectedHash === hash,
    signatureOk: expectedSignature === signature,
  };
}

interface StreamState {
  previousHash: string;
  seq: number;
}

/**
 * Creates an audit log bound to a specific directory. Production code uses
 * the default export (`keeperAuditLog`, rooted at `KEEPER_AUDIT_LOG_DIR` or
 * `./audit-logs`); tests create their own instance pointed at a temp dir so
 * runs never share or pollute state.
 */
export function createKeeperAuditLog(baseDir?: string) {
  const dir = baseDir ?? process.env.KEEPER_AUDIT_LOG_DIR ?? './audit-logs';
  const stateCache = new Map<string, StreamState>();

  function filePathFor(stream: string): string {
    return path.join(dir, `${stream}.jsonl`);
  }

  function readAllRecords(stream: string): KeeperDecisionRecord[] {
    const file = filePathFor(stream);
    if (!fs.existsSync(file)) return [];
    const content = fs.readFileSync(file, 'utf-8').trim();
    if (!content) return [];
    return content.split('\n').map((line) => JSON.parse(line) as KeeperDecisionRecord);
  }

  function loadState(stream: string): StreamState {
    const cached = stateCache.get(stream);
    if (cached) return cached;

    const records = readAllRecords(stream);
    const state: StreamState = records.length
      ? { previousHash: records[records.length - 1].hash, seq: records[records.length - 1].seq }
      : { previousHash: GENESIS_HASH, seq: -1 };
    stateCache.set(stream, state);
    return state;
  }

  /** Appends a new, redacted, hash-chained decision record to `stream`. */
  function appendDecision(stream: string, input: KeeperDecisionInput): KeeperDecisionRecord {
    fs.mkdirSync(dir, { recursive: true });
    const state = loadState(stream);

    const seq = state.seq + 1;
    const id = crypto.randomUUID();
    const timestamp = new Date().toISOString();

    const redactedInputs = redactSensitive(input.inputs ?? null);
    const redactedSimResult = redactSensitive(input.simulationResult ?? null);
    const redactedOutcome = redactSensitive(input.txOutcome ?? null);
    const redactedDecision = redactSensitive(input.decision);

    const base: Omit<KeeperDecisionRecord, 'hash' | 'signature'> = {
      id,
      seq,
      timestamp,
      stream,
      workerName: input.workerName,
      jobId: input.jobId,
      policyVersion: input.policyVersion,
      contractId: input.contractId,
      method: input.method,
      inputs: redactedInputs,
      decision: redactedDecision,
      simulationResult: redactedSimResult,
      txOutcome: redactedOutcome as KeeperTxOutcome | undefined,
      previousHash: state.previousHash,
    };

    const hash = generateHash(base);
    const signature = generateSignature(hash);
    const record: KeeperDecisionRecord = { ...base, hash, signature };

    fs.appendFileSync(filePathFor(stream), JSON.stringify(record) + '\n');
    stateCache.set(stream, { previousHash: hash, seq });

    return record;
  }

  /**
   * Walks a stream's records verifying: per-record hash/signature integrity,
   * hash-chain continuity (each `previousHash` matches the prior record's
   * `hash`), and a strictly increasing, gap-free `seq` (catches reordering
   * and missing/deleted records, not just tampering).
   */
  function verifyStreamIntegrity(stream: string): IntegrityResult {
    const records = readAllRecords(stream);
    let expectedPreviousHash = GENESIS_HASH;
    let expectedSeq = 0;

    for (let i = 0; i < records.length; i++) {
      const record = records[i];
      const { hashOk, signatureOk } = verifyRecord(record);

      if (!hashOk) {
        return { isValid: false, brokenAtIndex: i, reason: 'hash-mismatch' };
      }
      if (!signatureOk) {
        return { isValid: false, brokenAtIndex: i, reason: 'signature-mismatch' };
      }
      if (record.previousHash !== expectedPreviousHash) {
        return { isValid: false, brokenAtIndex: i, reason: 'chain-break' };
      }
      if (record.seq < expectedSeq) {
        return { isValid: false, brokenAtIndex: i, reason: 'sequence-reordered' };
      }
      if (record.seq > expectedSeq) {
        return { isValid: false, brokenAtIndex: i, reason: 'sequence-gap' };
      }

      expectedPreviousHash = record.hash;
      expectedSeq = record.seq + 1;
    }

    return { isValid: true, brokenAtIndex: null };
  }

  /** Returns records in `stream` whose timestamp falls within [from, to] (inclusive, both optional). */
  function exportStream(stream: string, from?: string, to?: string): KeeperDecisionRecord[] {
    let records = readAllRecords(stream);
    if (from) {
      const fromMs = new Date(from).getTime();
      records = records.filter((r) => new Date(r.timestamp).getTime() >= fromMs);
    }
    if (to) {
      const toMs = new Date(to).getTime();
      records = records.filter((r) => new Date(r.timestamp).getTime() <= toMs);
    }
    return records;
  }

  return { appendDecision, verifyStreamIntegrity, exportStream, readAllRecords };
}

export const keeperAuditLog = createKeeperAuditLog();
