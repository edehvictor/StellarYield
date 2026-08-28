import * as StellarSdk from '@stellar/stellar-sdk';
import { recordReplayError } from './indexerStatus';

const RPC_URL = process.env.RPC_URL || 'https://soroban-testnet.stellar.org';
const CONTRACT_ID = process.env.VITE_CONTRACT_ID || '';
const POLL_INTERVAL = 5000; // 5 seconds
const DECODER_VERSION = '1.0.0'; // Semver of current decoder logic

const rpcServer = new StellarSdk.rpc.Server(RPC_URL);

type IndexerPrismaClient = {
  indexerState: {
    findUnique(args: { where: { id: string } }): Promise<{ id: string; lastLedger: number } | null>;
    create(args: { data: { id: string; lastLedger: number } }): Promise<{ id: string; lastLedger: number }>;
    update(args: { where: { id: string }; data: { lastLedger: number } }): Promise<unknown>;
  };
  event: {
    upsert(args: {
      where: { txHash_topic_data: { txHash: string; topic: string; data: string } };
      update: Record<string, never>;
      create: {
        ledger: number;
        txHash: string;
        contractId: string;
        topic: string;
        data: string;
      };
    }): Promise<unknown>;
  };
  deadLetterEvent: {
    create(args: {
      data: {
        ledger: number;
        txHash: string;
        contractId: string;
        topic: string;
        data: string;
        decoderVersion: string;
        errorClass: string;
        errorMessage: string;
        nextRetryAt: Date;
        maxRetries: number;
      };
    }): Promise<unknown>;
    findMany(args: {
      where: {
        resolved: boolean;
        nextRetryAt?: { lte: Date };
        ledger?: { gte?: number; lte?: number };
      };
      orderBy?: { nextRetryAt: 'asc' };
      take?: number;
    }): Promise<Array<{
      id: string;
      ledger: number;
      txHash: string;
      contractId: string;
      topic: string;
      data: string;
      decoderVersion: string;
      errorClass: string;
      errorMessage: string;
      retryCount: number;
      maxRetries: number;
      nextRetryAt: Date;
    }>>;
    update(args: {
      where: { id: string };
      data: {
        retryCount?: number;
        nextRetryAt?: Date;
        lastErrorAt?: Date;
        resolved?: boolean;
        resolvedAt?: Date;
        errorMessage?: string;
      };
    }): Promise<unknown>;
    count(args: {
      where: {
        resolved: boolean;
      };
    }): Promise<number>;
    findFirst(args: {
      where: { resolved: boolean };
      orderBy: { nextRetryAt: 'asc' };
    }): Promise<{ nextRetryAt: Date } | null>;
  };
};

async function loadPrismaClient(): Promise<IndexerPrismaClient | null> {
  try {
    const prismaModule = (await import('@prisma/client')) as unknown as {
      PrismaClient?: new () => IndexerPrismaClient;
    };

    if (!prismaModule.PrismaClient) {
      return null;
    }

    return new prismaModule.PrismaClient();
  } catch (error) {
    console.warn('[Indexer] Prisma client is unavailable:', error);
    return null;
  }
}

/**
 * Decode a contract event topic into a human-readable action string.
 * Throws if the event is malformed or unsupported.
 */
function decodeEventTopic(topicXdr: string): string {
  if (!topicXdr || topicXdr.trim().length === 0) {
    throw new Error('Empty topic XDR');
  }
  // In production, this would parse the XDR ScVal into structured fields
  // For now, we validate the topic is non-empty and return it
  return topicXdr;
}

/**
 * Decode a contract event value into structured data.
 * Throws if the event value is malformed.
 */
function decodeEventValue(dataXdr: string): string {
  if (!dataXdr || dataXdr.trim().length === 0) {
    throw new Error('Empty event data XDR');
  }
  // In production, this would parse the XDR into structured fields
  // For now, we validate the data is non-empty and return it
  return dataXdr;
}

/**
 * Classify an error into a structured error class for dead-letter tracking.
 */
function classifyError(error: unknown): { errorClass: string; errorMessage: string } {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('decode') || message.includes('Decode') || message.includes('XDR')) {
    return { errorClass: 'DecodeError', errorMessage: message };
  }
  if (message.includes('project') || message.includes('Project') || message.includes('projector')) {
    return { errorClass: 'ProjectorError', errorMessage: message };
  }
  if (message.includes('validation') || message.includes('Validation')) {
    return { errorClass: 'ValidationError', errorMessage: message };
  }
  return { errorClass: 'UnknownError', errorMessage: message };
}

/**
 * Compute a backoff delay in milliseconds for retry attempts.
 * Uses exponential backoff with jitter: base * 2^retryCount + random(0, 1000)
 */
function computeRetryDelay(retryCount: number): number {
  const baseDelayMs = 10_000; // 10 seconds base
  const exponentialDelay = baseDelayMs * Math.pow(2, retryCount);
  const jitter = Math.random() * 1000;
  return Math.min(exponentialDelay + jitter, 300_000); // Cap at 5 minutes
}

/**
 * Process a single event: decode, validate, and store.
 * Returns true on success, false if the event should be dead-lettered.
 */
async function processEvent(
  prisma: IndexerPrismaClient,
  event: StellarSdk.rpc.Api.Event,
): Promise<boolean> {
  try {
    // Step 1: Extract raw event data
    const topic = event.topic.map(t => t.toXDR('base64')).join(':');
    const data = event.value.toXDR('base64');

    // Step 2: Decode the event (may throw for malformed events)
    const decodedTopic = decodeEventTopic(topic);
    const decodedData = decodeEventValue(data);

    // Step 3: Idempotent upsert to events table
    await prisma.event.upsert({
      where: {
        txHash_topic_data: {
          txHash: event.txHash,
          topic: decodedTopic,
          data: decodedData,
        },
      },
      update: {},
      create: {
        ledger: event.ledger,
        txHash: event.txHash,
        contractId: String(event.contractId ?? CONTRACT_ID),
        topic: decodedTopic,
        data: decodedData,
      },
    });

    return true;
  } catch (error) {
    // Step 4: On failure, record to dead-letter queue
    const { errorClass, errorMessage } = classifyError(error);
    const topic = event.topic.map(t => t.toXDR('base64')).join(':');
    const data = event.value.toXDR('base64');

    const nextRetryAt = new Date(Date.now() + computeRetryDelay(0));

    await prisma.deadLetterEvent.create({
      data: {
        ledger: event.ledger,
        txHash: event.txHash,
        contractId: String(event.contractId ?? CONTRACT_ID),
        topic,
        data,
        decoderVersion: DECODER_VERSION,
        errorClass,
        errorMessage,
        nextRetryAt,
        maxRetries: 3,
      },
    });

    console.warn(`[Indexer] Dead-lettered event at ledger ${event.ledger}: ${errorClass} - ${errorMessage}`);
    return false;
  }
}

/**
 * Replay a single dead-letter event. Attempts to decode and store it.
 * Updates retry count and resolves if successful.
 */
async function replayDeadLetter(
  prisma: IndexerPrismaClient,
  deadLetter: {
    id: string;
    ledger: number;
    txHash: string;
    contractId: string;
    topic: string;
    data: string;
    decoderVersion: string;
    retryCount: number;
    maxRetries: number;
  },
): Promise<boolean> {
  try {
    // Attempt to decode the stored raw data
    const decodedTopic = decodeEventTopic(deadLetter.topic);
    const decodedData = decodeEventValue(deadLetter.data);

    // If decode succeeds, upsert to events table
    await prisma.event.upsert({
      where: {
        txHash_topic_data: {
          txHash: deadLetter.txHash,
          topic: decodedTopic,
          data: decodedData,
        },
      },
      update: {},
      create: {
        ledger: deadLetter.ledger,
        txHash: deadLetter.txHash,
        contractId: deadLetter.contractId,
        topic: decodedTopic,
        data: decodedData,
      },
    });

    // Mark as resolved
    await prisma.deadLetterEvent.update({
      where: { id: deadLetter.id },
      data: {
        resolved: true,
        resolvedAt: new Date(),
      },
    });

    console.log(`[Indexer] Successfully replayed dead-letter event ${deadLetter.id} at ledger ${deadLetter.ledger}`);
    return true;
  } catch (error) {
    const { errorMessage } = classifyError(error);
    const newRetryCount = deadLetter.retryCount + 1;
    const isExhausted = newRetryCount >= deadLetter.maxRetries;

    await prisma.deadLetterEvent.update({
      where: { id: deadLetter.id },
      data: {
        retryCount: newRetryCount,
        lastErrorAt: new Date(),
        errorMessage,
        nextRetryAt: isExhausted
          ? new Date(Date.now() + 86_400_000) // Retry again in 24h if exhausted
          : new Date(Date.now() + computeRetryDelay(newRetryCount)),
        ...(isExhausted ? {} : {}),
      },
    });

    console.warn(
      `[Indexer] Dead-letter replay failed for ${deadLetter.id} ` +
      `(attempt ${newRetryCount}/${deadLetter.maxRetries}): ${errorMessage}`,
    );
    return false;
  }
}

/**
 * Replay all unresolved dead-letter events that are due for retry.
 * Returns the number of successfully replayed events.
 */
export async function replayDeadLetters(prisma: IndexerPrismaClient): Promise<number> {
  const dueForRetry = await prisma.deadLetterEvent.findMany({
    where: {
      resolved: false,
      nextRetryAt: { lte: new Date() },
    },
    orderBy: { nextRetryAt: 'asc' },
    take: 50,
  });

  let successCount = 0;
  for (const dl of dueForRetry) {
    const ok = await replayDeadLetter(prisma, dl);
    if (ok) successCount++;
  }

  return successCount;
}

/**
 * Replay a single dead-letter event by ID.
 * Returns true if the replay was successful.
 */
export async function replayDeadLetterById(
  prisma: IndexerPrismaClient,
  deadLetterId: string,
): Promise<boolean> {
  // Find the dead-letter event
  const allDeadLetters = await prisma.deadLetterEvent.findMany({
    where: { resolved: false },
    take: 1000,
  });

  const deadLetter = allDeadLetters.find(dl => dl.id === deadLetterId);
  if (!deadLetter) {
    console.warn(`[Indexer] Dead-letter event ${deadLetterId} not found or already resolved`);
    return false;
  }

  return replayDeadLetter(prisma, deadLetter);
}

/**
 * Replay dead-letter events for a specific ledger range.
 * Returns the number of successfully replayed events.
 */
export async function replayDeadLettersByLedgerRange(
  prisma: IndexerPrismaClient,
  startLedger: number,
  endLedger: number,
): Promise<number> {
  const inRange = await prisma.deadLetterEvent.findMany({
    where: {
      resolved: false,
      ledger: { gte: startLedger, lte: endLedger },
    },
    orderBy: { nextRetryAt: 'asc' },
    take: 100,
  });

  let successCount = 0;
  for (const dl of inRange) {
    const ok = await replayDeadLetter(prisma, dl);
    if (ok) successCount++;
  }

  return successCount;
}

/**
 * Get the oldest unresolved dead-letter event timestamp.
 * Returns null if no unresolved dead letters exist.
 */
export async function getOldestUnresolvedDeadLetter(
  prisma: IndexerPrismaClient,
): Promise<Date | null> {
  const oldest = await prisma.deadLetterEvent.findFirst({
    where: { resolved: false },
    orderBy: { nextRetryAt: 'asc' },
  });

  return oldest?.nextRetryAt ?? null;
}

/**
 * Get the count of unresolved dead-letter events.
 */
export async function getUnresolvedDeadLetterCount(
  prisma: IndexerPrismaClient,
): Promise<number> {
  return prisma.deadLetterEvent.count({
    where: { resolved: false },
  });
}

/**
 * Filter for specific events from our Soroban Vault contract.
 * We parse the XDR and store it in PostgreSQL.
 * Failed events are recorded in the dead-letter queue for later replay.
 */
export async function startIndexer() {
  console.log('[Indexer] Starting StellarYield event indexer...');
  const prisma = await loadPrismaClient();

  if (!prisma) {
    console.warn('[Indexer] Prisma client has not been generated; skipping indexer startup.');
    return;
  }

  // 1. Recover last processed ledger
  let state = await prisma.indexerState.findUnique({ where: { id: 'singleton' } });
  if (!state) {
    state = await prisma.indexerState.create({ data: { id: 'singleton', lastLedger: 0 } });
  }

  let startLedger = state.lastLedger;

  // 2. Indexer loop
  const poll = async () => {
    try {
      const latestLedger = await rpcServer.getLatestLedger();
      const endLedger = latestLedger.sequence;

      if (startLedger >= endLedger) {
        // No new ledgers - try replaying dead letters
        const replayed = await replayDeadLetters(prisma);
        if (replayed > 0) {
          console.log(`[Indexer] Replayed ${replayed} dead-letter events`);
        }
        setTimeout(poll, POLL_INTERVAL);
        return;
      }

      console.log(`[Indexer] Catching up from ${startLedger} to ${endLedger}...`);

      const eventsResponse = await rpcServer.getEvents({
        startLedger: startLedger,
        filters: [
          {
            type: 'contract',
            contractIds: [CONTRACT_ID],
          },
        ],
        limit: 100,
      });

      let failedCount = 0;
      for (const event of eventsResponse.events) {
        const ok = await processEvent(prisma, event);
        if (!ok) failedCount++;
      }

      // 3. Update state only after all events processed (dead-lettered failures don't block)
      startLedger = endLedger;
      await prisma.indexerState.update({
        where: { id: 'singleton' },
        data: { lastLedger: startLedger },
      });

      const statusMsg = failedCount > 0
        ? ` (${failedCount} events dead-lettered)`
        : '';
      console.log(`[Indexer] Successfully processed up to ledger ${startLedger}${statusMsg}`);

      // Try replaying any due dead letters
      const replayed = await replayDeadLetters(prisma);
      if (replayed > 0) {
        console.log(`[Indexer] Replayed ${replayed} dead-letter events`);
      }

      setTimeout(poll, POLL_INTERVAL);
    } catch (error) {
      console.error('[Indexer] Error:', error);
      recordReplayError(
        error instanceof Error ? error.message : String(error),
        startLedger,
      );
      setTimeout(poll, POLL_INTERVAL); // Retry
    }
  };

  poll();
}