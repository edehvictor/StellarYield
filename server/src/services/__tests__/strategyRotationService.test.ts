import { decideRotation, getRotationHistory, clearRotationHistory } from '../strategyRotationService';
import { exportRotationCsv } from '../export/csvExporter';
import { exportRotationJson } from '../export/jsonExporter';

describe('strategyRotationService & exporters', () => {
  beforeEach(() => clearRotationHistory());

  test('decideRotation records winner and skipped', () => {
    const candidates = [
      { id: 'a', score: 10, confidence: 80 },
      { id: 'b', score: 12, confidence: 30 },
    ];
    const rec = decideRotation(candidates as any, { note: 'test' });
    expect(rec.winner).toBeDefined();
    expect(rec.winner!.id).toBe('a'); // a: 10*(0.8)=8, b:12*(0.3)=3.6
    const hist = getRotationHistory();
    expect(hist.length).toBe(1);
  });

  test('export formatting and empty-history', () => {
    const emptyCsv = exportRotationCsv([]);
    const emptyJson = exportRotationJson([]);
    expect(emptyCsv.split('\n')[0]).toContain('timestamp');
    const parsed = JSON.parse(emptyJson);
    expect(parsed.records).toEqual([]);
  });
});
