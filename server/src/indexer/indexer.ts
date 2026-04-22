import * as StellarSdk from '@stellar/stellar-sdk';
const RPC_URL = process.env.RPC_URL || 'https://soroban-testnet.stellar.org';
const CONTRACT_ID = process.env.VITE_CONTRACT_ID || '';
const POLL_INTERVAL = 5000; // 5 seconds

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
};

async function loadPrismaClient(): Promise<IndexerPrismaClient | null> {
  try {
    const prismaModule = (await import('@prisma/client')) as {
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
 * Filter for specific events from our Soroban Vault contract.
 * We parse the XDR and store it in PostgreSQL.
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
        setTimeout(poll, POLL_INTERVAL);
        return;
      }

      console.log(`[Indexer] Catching up from ${startLedger} to ${endLedger}...`);

      const eventsResponse = await rpcServer.getEvents({
        startLedger: startLedger,
        filters: [
          {
            type: 'contract',
            contractIds: [CONTRACT_ID]
          }
        ],
        limit: 100
      });

      for (const event of eventsResponse.events) {
        // Parse topic (assume basic Symbol topic for now)
        const topic = event.topic.map(t => t.toXDR('base64')).join(':');
        const data = event.value.toXDR('base64');

        // Idempotent upsert
        await prisma.event.upsert({
          where: {
            txHash_topic_data: {
              txHash: event.txHash,
              topic: topic,
              data: data
            }
          },
          update: {},
          create: {
            ledger: event.ledger,
            txHash: event.txHash,
            contractId: String(event.contractId ?? CONTRACT_ID),
            topic: topic,
            data: data
          }
        });
      }

      // 3. Update state
      startLedger = endLedger;
      await prisma.indexerState.update({
        where: { id: 'singleton' },
        data: { lastLedger: startLedger }
      });

      console.log(`[Indexer] Successfully processed up to ledger ${startLedger}`);
      setTimeout(poll, POLL_INTERVAL);
    } catch (error) {
      console.error('[Indexer] Error:', error);
      setTimeout(poll, POLL_INTERVAL); // Retry
    }
  };

  poll();
}
