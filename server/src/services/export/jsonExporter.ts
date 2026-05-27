import type { RotationRecord } from '../strategyRotationService';

export function exportRotationJson(records: RotationRecord[]) {
  return JSON.stringify({ exportedAt: new Date().toISOString(), records }, null, 2);
}

export default exportRotationJson;
