import type { RotationRecord } from '../strategyRotationService';

function escapeCsv(value: any) {
  if (value === null || value === undefined) return '';
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  if (s.includes(',') || s.includes('\n') || s.includes('"')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

export function exportRotationCsv(records: RotationRecord[]) {
  const headers = ['timestamp', 'winner_id', 'winner_score', 'winner_confidence', 'skipped_json', 'metadata_json'];
  const rows = records.map((r) => {
    const winner = r.winner;
    return [
      r.timestamp,
      winner ? winner.id : '',
      winner ? winner.score : '',
      winner && typeof winner.confidence === 'number' ? winner.confidence : '',
      escapeCsv(r.skipped.map((s) => ({ id: s.candidate.id, reason: s.reason }))),
      escapeCsv(r.metadata ?? ''),
    ].join(',');
  });
  return [headers.join(','), ...rows].join('\n');
}

export default exportRotationCsv;
