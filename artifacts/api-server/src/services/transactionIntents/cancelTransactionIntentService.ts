import { ApiError } from "../../lib/errors";
import type {
  CancelTransactionIntentInput,
  CancelTransactionIntentUseCase,
  TransactionIntentRecord,
  TransactionIntentRepository,
} from "./types";

/**
 * Cancels a pending transaction intent on behalf of its owning client.
 *
 * Execution order is deliberate — identity and state are verified before any
 * write happens, and the final write is an atomic compare-and-set so racing
 * requests resolve to deterministic typed errors instead of double writes:
 *
 * 1. Load the intent (typed 404 when absent or cleared).
 * 2. Enforce client ownership (typed 403 on mismatch).
 * 3. Enforce the pending state (typed 409 once processed/cancelled/cleared).
 * 4. Compare-and-set cancel inside a database transaction (typed 409/404 if
 *    the row changed between steps; the outcome is re-classified by re-reading).
 *
 * Repository/network failures are wrapped into a stable typed 503; the raw
 * provider error is attached as `cause` for logging and never serialized.
 */
export class CancelTransactionIntentService
  implements CancelTransactionIntentUseCase
{
  public constructor(
    private readonly intents: TransactionIntentRepository,
  ) {}

  public async execute(
    input: CancelTransactionIntentInput,
  ): Promise<TransactionIntentRecord> {
    const cancelledAt = input.now ?? new Date();

    const intent = await this.findIntent(input.intentId);

    if (intent === null) {
      throw ApiError.intentNotFound();
    }

    if (intent.clientId !== input.clientId) {
      throw ApiError.intentClientMismatch();
    }

    if (intent.status !== "pending") {
      throw ApiError.intentAlreadyProcessed();
    }

    const cancelled = await this.cancelIntent(
      intent.id,
      input.clientId,
      cancelledAt,
    );

    if (cancelled !== null) {
      return cancelled;
    }

    // The compare-and-set lost a race: re-read to return a precise typed
    // reason (gone -> 404, otherwise -> 409) rather than a generic failure.
    const latest = await this.findIntent(intent.id);

    if (latest === null) {
      throw ApiError.intentNotFound();
    }

    throw ApiError.intentAlreadyProcessed();
  }

  private async findIntent(
    intentId: string,
  ): Promise<TransactionIntentRecord | null> {
    try {
      return await this.intents.findById(intentId);
    } catch (cause) {
      throw ApiError.intentServiceUnavailable(cause);
    }
  }

  private async cancelIntent(
    intentId: string,
    clientId: string,
    cancelledAt: Date,
  ): Promise<TransactionIntentRecord | null> {
    try {
      return await this.intents.cancelIfPending(
        intentId,
        clientId,
        cancelledAt,
      );
    } catch (cause) {
      throw ApiError.intentServiceUnavailable(cause);
    }
  }
}
