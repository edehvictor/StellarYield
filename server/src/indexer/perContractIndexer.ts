/**
 * Per-Contract Cursor Checkpointing for Soroban Event Ingestion (Issue #888)
 * 
 * This module implements per-contract, per-network cursor tracking to avoid
 * permanent gaps in portfolio, PnL, and audit projections when dealing with
 * multiple contracts.
 */

import * as StellarSdk from '@stellar/stellar-sdk';
import { recordReplayError } from './indexerStatus';
import { recordGapEvent, validateNetworkContinuity } from './continuitychecks';
import {
  EventCursorError,
  computeEventPageCheckpoint,
  extractRpcCursor,
} from './eventCursorCheckpoint';

const RPC_URL = process.env.RPC_URL || 'https://soroban-testnet.stellar.org';
const NETWORK_PASSPHRASE = process.env.NETWORK_PASSPHRASE || StellarSdk.Networks.TESTNET;
const POLL_INTERVAL = 5000; // 5 seconds
const MAX_EVENTS_PER_PAGE = 100;

const rpcServer = new StellarSdk.rpc.Server(RPC_URL);

type PrismaClient = any; // Use actual PrismaClient type in production

interface ContractConfig {
  contractId: string;
  networkId: string;
  streamType: 'events' | 'diagnostics' | 'transactions';
  deploymentLedger: number;
}

/**
 * Load Prisma client dynamically.
 */
async function loadPrismaClient(): Promise<PrismaClient | null> {
  try {
    const prismaModule = (await import('@prisma/client')) as any;
    if (!prismaModule.PrismaClient) {
      return null;
    }
    return new prismaModule.PrismaClient();
  } catch (error) {
    console.warn('[PerContractIndexer] Prisma client unavailable:', error);
    return null;
  }
}

/**
 * Generate stable event identity for idempotency.
 * Format: contractId:ledger:txHash:topicHash
 */
function generateEventIdentity(
  contractId: string,
  ledger: number,
  txHash: string,
  topics: string[]
): string {
  const topicHash = topics.join(':');
  return `${contractId}:${ledger}:${txHash}:${topicHash}`;
}

/**
 * Initialize or recover cursor for a specific contract.
 */
async function getOrCreateCursor(
  prisma: PrismaClient,
  config: ContractConfig
): Promise<{ lastLedger: number; cursorPosition: string | null }> {
  let cursor = await prisma.contractIndexerCursor.findUnique({
    where: { contractId: config.contractId },
  });

  if (!cursor) {
    console.log(`[PerContractIndexer] Creating new cursor for ${config.contractId}`);
    cursor = await prisma.contractIndexerCursor.create({
      data: {
        contractId: config.contractId,
        networkId: config.networkId,
        streamType: config.streamType,
        lastLedger: config.deploymentLedger,
        status: 'ACTIVE',
      },
    });
  }

  return {
    lastLedger: cursor.lastLedger,
    cursorPosition: cursor.cursorPosition,
  };
}

/**
 * Update cursor checkpoint after successful page ingestion.
 */
async function updateCursorCheckpoint(
  prisma: PrismaClient,
  contractId: string,
  lastLedger: number,
  lastTxHash: string | null,
  cursorPosition: string | null
): Promise<void> {
  await prisma.contractIndexerCursor.update({
    where: { contractId },
    data: {
      lastLedger,
      lastTxHash,
      lastProcessedAt: new Date(),
      cursorPosition,
      errorCount: 0,
      lastError: null,
      checkpointAge: 0,
    },
  });
}

/**
 * Record error for a specific contract cursor.
 */
async function recordCursorError(
  prisma: PrismaClient,
  contractId: string,
  error: string
): Promise<void> {
  await prisma.contractIndexerCursor.update({
    where: { contractId },
    data: {
      status: 'ERROR',
      errorCount: { increment: 1 },
      lastError: error,
      lastErrorAt: new Date(),
    },
  });
}

/**
 * Ingest events for a single contract with pagination support.
 */
async function ingestContractEvents(
  prisma: PrismaClient,
  config: ContractConfig
): Promise<void> {
  const cursor = await getOrCreateCursor(prisma, config);
  let startLedger = cursor.lastLedger;
  let pageCursor = cursor.cursorPosition;
  let hasMorePages = true;

  try {
    // Validate network continuity before ingestion
    await validateNetworkContinuity(prisma, config.contractId, NETWORK_PASSPHRASE, config.deploymentLedger);

    const latestLedger = await rpcServer.getLatestLedger();
    const endLedger = latestLedger.sequence;

    if (startLedger >= endLedger) {
      console.log(`[PerContractIndexer] ${config.contractId} is up to date at ledger ${startLedger}`);
      return;
    }

    console.log(`[PerContractIndexer] Indexing ${config.contractId} from ${startLedger} to ${endLedger}...`);

    // Detect ledger gaps
    if (startLedger < endLedger - 100) {
      await recordGapEvent(prisma, config.contractId, 'LEDGER_SKIP', startLedger, endLedger);
    }

    // Paginated ingestion
    while (hasMorePages && startLedger < endLedger) {
      const eventsResponse = await rpcServer.getEvents({
        startLedger: startLedger + 1,
        filters: [
          {
            type: 'contract',
            contractIds: [config.contractId],
          },
        ],
        limit: MAX_EVENTS_PER_PAGE,
        cursor: pageCursor || undefined,
      });

      for (const event of eventsResponse.events) {
        const topics = event.topic.map((t) => t.toXDR('base64'));
        const data = event.value.toXDR('base64');
        const eventIdentity = generateEventIdentity(
          config.contractId,
          event.ledger,
          event.txHash,
          topics
        );

        // Idempotent ingestion
        await prisma.eventIngestionLog.upsert({
          where: { eventIdentity },
          update: {},
          create: {
            contractId: config.contractId,
            ledger: event.ledger,
            txHash: event.txHash,
            eventIdentity,
            rawXdr: data,
            topics: topics,
            decoderVersion: '1.0',
            ingestedAt: new Date(),
          },
        });

        // Also store in legacy Event table for backward compatibility
        await prisma.event.upsert({
          where: {
            txHash_topic_data: {
              txHash: event.txHash,
              topic: topics.join(':'),
              data: data,
            },
          },
          update: {},
          create: {
            ledger: event.ledger,
            txHash: event.txHash,
            contractId: config.contractId,
            topic: topics.join(':'),
            data: data,
          },
        });
      }

      // Check if there are more pages; advance using the RPC pagination
      // cursor so a crash mid-pagination resumes at exactly this next page
      // instead of re-scanning the ledger range (#1289).
      const rpcCursor = extractRpcCursor(eventsResponse);
      const outcome = computeEventPageCheckpoint({
        lastLedger: startLedger,
        endLedger,
        events: eventsResponse.events,
        rpcCursor,
        limit: MAX_EVENTS_PER_PAGE,
      });

      if (!outcome.ok) {
        throw new EventCursorError(
          outcome.error.code,
          outcome.error.message,
          outcome.error.meta,
        );
      }

      const checkpoint = outcome.checkpoint;
      startLedger = checkpoint.lastLedger;
      hasMorePages = checkpoint.hasMorePages;
      pageCursor = checkpoint.cursorPosition;

      // Update cursor after each page
      await updateCursorCheckpoint(
        prisma,
        config.contractId,
        startLedger,
        eventsResponse.events.length > 0
          ? eventsResponse.events[eventsResponse.events.length - 1].txHash
          : null,
        hasMorePages ? pageCursor : null
      );

      console.log(
        `[PerContractIndexer] ${config.contractId}: Processed page up to ledger ${startLedger}`
      );
    }

    console.log(`[PerContractIndexer] ${config.contractId}: Successfully indexed to ledger ${startLedger}`);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`[PerContractIndexer] ${config.contractId}: Error:`, errorMessage);
    
    await recordCursorError(prisma, config.contractId, errorMessage);
    recordReplayError(errorMessage, startLedger);
    
    throw error;
  }
}

/**
 * Start per-contract indexer for multiple contracts.
 */
export async function startPerContractIndexer(contracts: ContractConfig[]): Promise<void> {
  console.log('[PerContractIndexer] Starting per-contract event indexer...');
  const prisma = await loadPrismaClient();

  if (!prisma) {
    console.warn('[PerContractIndexer] Prisma client unavailable; skipping startup.');
    return;
  }

  const poll = async () => {
    for (const contract of contracts) {
      try {
        await ingestContractEvents(prisma, contract);
      } catch (error) {
        console.error(`[PerContractIndexer] Failed to index ${contract.contractId}:`, error);
        // Continue with other contracts
      }
    }

    setTimeout(poll, POLL_INTERVAL);
  };

  poll();
}
