import type { DigestPayload, DeliveryResult, DeliveryRetryMetadata } from './types';
import { renderDigestEmail } from '../../templates/digestEmailTemplate';

export interface DigestDeliveryRetryConfig {
  maxRetries: number;
  baseBackoffMs: number;
  now?: () => Date;
}

const DEFAULT_RETRY_CONFIG: DigestDeliveryRetryConfig = {
  maxRetries: 3,
  baseBackoffMs: 30_000,
};

export class DigestDeliveryService {
  constructor(
    private emailLookup: (walletAddress: string) => Promise<string | null>,
    private sendEmail: (to: string, subject: string, html: string) => Promise<void>,
    private retryConfig: DigestDeliveryRetryConfig = DEFAULT_RETRY_CONFIG,
  ) {}

  async deliver(payload: DigestPayload, retryCount = 0): Promise<DeliveryResult> {
    const email = await this.emailLookup(payload.walletAddress);

    if (!email) {
      const retry = this.buildRetryMetadata("terminal", retryCount, "Wallet has no delivery email configured.");
      console.error(
        `[DigestDeliveryService] MISSING_EMAIL for walletAddress=${payload.walletAddress}`,
      );
      return { ok: false, error: 'MISSING_EMAIL', retry };
    }

    const html = this.renderHtml(payload);
    const subject = `Your Notification Digest - ${payload.clusters.length} update(s)`;

    try {
      await this.sendEmail(email, subject, html);
      return { ok: true };
    } catch (error) {
      const exhausted = retryCount >= this.retryConfig.maxRetries;
      const retry = this.buildRetryMetadata(
        exhausted ? "retry_exhausted" : "temporary",
        retryCount,
        error instanceof Error ? error.message : "Digest delivery failed.",
      );
      console.error(
        `[DigestDeliveryService] DELIVERY_FAILED walletAddress=${payload.walletAddress} status=${retry.status} retryCount=${retry.retryCount}`,
      );
      return { ok: false, error: 'DELIVERY_FAILED', retry };
    }
  }

  renderHtml(payload: DigestPayload): string {
    return renderDigestEmail(payload);
  }

  private buildRetryMetadata(
    status: DeliveryRetryMetadata["status"],
    retryCount: number,
    message: string,
  ): DeliveryRetryMetadata {
    const maxRetries = this.retryConfig.maxRetries;
    const backoffMs = status === "temporary"
      ? this.retryConfig.baseBackoffMs * Math.pow(2, retryCount)
      : 0;
    const now = this.retryConfig.now?.() ?? new Date();
    const nextRetryAt = status === "temporary"
      ? new Date(now.getTime() + backoffMs).toISOString()
      : null;

    return {
      retryCount,
      maxRetries,
      nextRetryAt,
      backoffMs,
      status,
      message,
    };
  }
}