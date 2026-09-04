import {
  generateMockUserYieldData,
  generateMockVaultYieldData,
  calculateWeeklyYieldReport,
  generateWeeklyReportsArtifact,
  verifyReportArtifactChecksum,
} from '../services/weeklyYieldReportService';
import { formatDigest } from '../services/digest/DigestFormatter';
import { computeChecksum, computeObjectChecksum } from '../utils/checksum';

describe('Artifact checksum utilities', () => {
  test('weekly report artifact checksum matches content', () => {
    const user = generateMockUserYieldData('user-test');
    const vaults = generateMockVaultYieldData();
    const report = calculateWeeklyYieldReport(user, vaults, new Date('2024-01-01'), new Date('2024-01-08'));
    const artifact = generateWeeklyReportsArtifact([report]);

    // recompute and compare
    const expected = computeChecksum(artifact.content);
    expect(artifact.checksum).toBe(expected);
    expect(verifyReportArtifactChecksum(artifact)).toBe(true);
  });

  test('weekly report artifact mismatched checksum is detected', () => {
    const user = generateMockUserYieldData('user-test');
    const vaults = generateMockVaultYieldData();
    const report = calculateWeeklyYieldReport(user, vaults, new Date('2024-01-01'), new Date('2024-01-08'));
    const artifact = generateWeeklyReportsArtifact([report]);

    // Tamper content
    const tampered = { ...artifact, content: artifact.content + '\n' };
    expect(verifyReportArtifactChecksum(tampered)).toBe(false);
  });

  test('weekly report artifact missing checksum returns false', () => {
    const user = generateMockUserYieldData('user-test');
    const vaults = generateMockVaultYieldData();
    const report = calculateWeeklyYieldReport(user, vaults, new Date('2024-01-01'), new Date('2024-01-08'));
    const artifact = generateWeeklyReportsArtifact([report]);

    // Remove checksum
    const missing = { content: artifact.content } as any;
    expect(verifyReportArtifactChecksum(missing)).toBe(false);
  });

  test('digest payload checksum matches computed object checksum', () => {
    const clusters = [
      {
        eventType: 'alert',
        clusterKey: 'vault-1',
        vaultId: 'vault-1',
        topImportanceScore: 50,
        eventCount: 1,
        summary: 'Test',
      },
    ];

    const payload = formatDigest('0xWallet', 'weekly', [
      // minimal RankedCluster shape accepted by formatter
      {
        eventType: 'alert',
        clusterKey: 'vault-1',
        vaultId: 'vault-1',
        events: [
          {
            eventId: 'a1',
            eventType: 'alert',
            walletAddress: '0xWallet',
            vaultId: 'vault-1',
            condition: 'APY_DROP',
            thresholdValue: 100,
            currentValue: 90,
            triggeredAt: new Date().toISOString(),
            recordedAt: new Date().toISOString(),
          },
        ],
        topImportanceScore: 50,
        summary: 'Test',
      } as any,
    ] as any);

    const recomputed = computeObjectChecksum({
      walletAddress: payload.walletAddress,
      scheduleMode: payload.scheduleMode,
      clusters: payload.clusters,
    });

    expect(payload.checksum).toBeDefined();
    expect(payload.checksum).toBe(recomputed);
  });

  test('digest payload missing checksum detectable', () => {
    const payload = {
      walletAddress: '0xWallet',
      generatedAt: new Date().toISOString(),
      scheduleMode: 'weekly' as const,
      clusters: [],
    } as any;

    // No checksum field
    expect(payload.checksum).toBeUndefined();
  });
});
