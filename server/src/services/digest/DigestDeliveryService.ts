import type { DigestPayload, DeliveryResult } from './types';
import { renderDigestEmail } from '../../templates/digestEmailTemplate';

/**
 * DigestDeliveryService
 * Renders a DigestPayload to HTML and dispatches it via email.
 * Requirements: 6.6, 7.3, 7.4
 */
export class DigestDeliveryService {
  constructor(
    private emailLookup: (walletAddress: string) => Promise<string | null>,
    private sendEmail: (to: string, subject: string, html: string) => Promise<void>,
  ) {}

  async deliver(payload: DigestPayload): Promise<DeliveryResult> {
    const email = await this.emailLookup(payload.walletAddress);

    if (!email) {
      console.error(
        `[DigestDeliveryService] MISSING_EMAIL for walletAddress=${payload.walletAddress}`,
      );
      return { ok: false, error: 'MISSING_EMAIL' };
    }

    const html = this.renderHtml(payload);
    const subject = `Your Notification Digest — ${payload.clusters.length} update(s)`;

    await this.sendEmail(email, subject, html);

    return { ok: true };
  }

  renderHtml(payload: DigestPayload): string {
    return renderDigestEmail(payload);
  }
}
