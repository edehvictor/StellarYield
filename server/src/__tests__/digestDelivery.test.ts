/**
 * Unit tests for DigestDeliveryService
 * Requirements: 6.6, 7.3, 7.4
 */

import { DigestDeliveryService } from '../services/digest/DigestDeliveryService';
import type { DigestPayload } from '../services/digest/types';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makePayload(overrides: Partial<DigestPayload> = {}): DigestPayload {
  return {
    walletAddress: '0xABCDEF1234567890',
    generatedAt: new Date().toISOString(),
    scheduleMode: 'daily',
    clusters: [
      {
        eventType: 'alert',
        topImportanceScore: 75,
        eventCount: 2,
        summary: 'APY_DROP threshold of 5 triggered for vault vault-1',
      },
    ],
    ...overrides,
  };
}

// ─── MISSING_EMAIL path ───────────────────────────────────────────────────────

describe('DigestDeliveryService - MISSING_EMAIL', () => {
  test('returns { ok: false, error: "MISSING_EMAIL" } when emailLookup returns null', async () => {
    const emailLookup = jest.fn().mockResolvedValue(null);
    const sendEmail = jest.fn();
    const service = new DigestDeliveryService(emailLookup, sendEmail);

    const result = await service.deliver(makePayload());

    expect(result).toEqual({ ok: false, error: 'MISSING_EMAIL' });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  test('does not call sendEmail when email is missing', async () => {
    const emailLookup = jest.fn().mockResolvedValue(null);
    const sendEmail = jest.fn();
    const service = new DigestDeliveryService(emailLookup, sendEmail);

    await service.deliver(makePayload({ walletAddress: '0xNoEmail' }));

    expect(sendEmail).not.toHaveBeenCalled();
  });

  test('calls emailLookup with the correct walletAddress', async () => {
    const emailLookup = jest.fn().mockResolvedValue(null);
    const sendEmail = jest.fn();
    const service = new DigestDeliveryService(emailLookup, sendEmail);

    await service.deliver(makePayload({ walletAddress: '0xSpecificWallet' }));

    expect(emailLookup).toHaveBeenCalledWith('0xSpecificWallet');
  });
});

// ─── Successful delivery ──────────────────────────────────────────────────────

describe('DigestDeliveryService - successful delivery', () => {
  test('returns { ok: true } when email is found and sendEmail succeeds', async () => {
    const emailLookup = jest.fn().mockResolvedValue('user@example.com');
    const sendEmail = jest.fn().mockResolvedValue(undefined);
    const service = new DigestDeliveryService(emailLookup, sendEmail);

    const result = await service.deliver(makePayload());

    expect(result).toEqual({ ok: true });
  });

  test('calls sendEmail with correct to, subject, and html', async () => {
    const emailLookup = jest.fn().mockResolvedValue('user@example.com');
    const sendEmail = jest.fn().mockResolvedValue(undefined);
    const service = new DigestDeliveryService(emailLookup, sendEmail);

    const payload = makePayload({ clusters: [
      { eventType: 'alert', topImportanceScore: 50, eventCount: 3, summary: 'test' },
      { eventType: 'watchlist', topImportanceScore: 20, eventCount: 1, summary: 'watch' },
    ]});

    await service.deliver(payload);

    expect(sendEmail).toHaveBeenCalledWith(
      'user@example.com',
      'Your Notification Digest — 2 update(s)',
      expect.stringContaining('<!DOCTYPE html>'),
    );
  });

  test('subject line includes the correct cluster count', async () => {
    const emailLookup = jest.fn().mockResolvedValue('user@example.com');
    const sendEmail = jest.fn().mockResolvedValue(undefined);
    const service = new DigestDeliveryService(emailLookup, sendEmail);

    const payload = makePayload({ clusters: [] });
    await service.deliver(payload);

    const [, subject] = (sendEmail as jest.Mock).mock.calls[0] as [string, string, string];
    expect(subject).toBe('Your Notification Digest — 0 update(s)');
  });
});

// ─── renderHtml output ────────────────────────────────────────────────────────

describe('DigestDeliveryService - renderHtml', () => {
  test('renderHtml returns a string containing DOCTYPE html', () => {
    const service = new DigestDeliveryService(
      jest.fn(),
      jest.fn(),
    );
    const html = service.renderHtml(makePayload());
    expect(html).toContain('<!DOCTYPE html>');
  });

  test('renderHtml includes the truncated wallet address', () => {
    const service = new DigestDeliveryService(jest.fn(), jest.fn());
    const html = service.renderHtml(makePayload({ walletAddress: '0xABCDEF1234567890' }));
    // truncateWallet: first 6 chars + ... + last 4 chars
    expect(html).toContain('0xABCD...7890');
  });

  test('renderHtml includes cluster summary text', () => {
    const service = new DigestDeliveryService(jest.fn(), jest.fn());
    const payload = makePayload({
      clusters: [{
        eventType: 'alert',
        topImportanceScore: 80,
        eventCount: 1,
        summary: 'APY_DROP threshold of 5 triggered for vault vault-42',
      }],
    });
    const html = service.renderHtml(payload);
    expect(html).toContain('APY_DROP threshold of 5 triggered for vault vault-42');
  });

  test('renderHtml shows "No new notifications" when clusters is empty', () => {
    const service = new DigestDeliveryService(jest.fn(), jest.fn());
    const html = service.renderHtml(makePayload({ clusters: [] }));
    expect(html).toContain('No new notifications in this digest.');
  });

  test('renderHtml escapes HTML special characters in summary', () => {
    const service = new DigestDeliveryService(jest.fn(), jest.fn());
    const payload = makePayload({
      clusters: [{
        eventType: 'alert',
        topImportanceScore: 50,
        eventCount: 1,
        summary: '<script>alert("xss")</script>',
      }],
    });
    const html = service.renderHtml(payload);
    expect(html).not.toContain('<script>alert("xss")</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  test('renderHtml includes total event count in stat card', () => {
    const service = new DigestDeliveryService(jest.fn(), jest.fn());
    const payload = makePayload({
      clusters: [
        { eventType: 'alert', topImportanceScore: 50, eventCount: 3, summary: 'a' },
        { eventType: 'watchlist', topImportanceScore: 20, eventCount: 2, summary: 'b' },
      ],
    });
    const html = service.renderHtml(payload);
    // Total = 3 + 2 = 5
    expect(html).toContain('>5<');
  });
});
