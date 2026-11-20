import crypto from 'crypto';

export function computeChecksum(input: string): string {
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex');
}

export function computeObjectChecksum(obj: unknown): string {
  // Stable stringify: JSON with deterministic key ordering
  const stableStringify = (o: any): string => {
    if (o === null || typeof o !== 'object') return JSON.stringify(o);
    if (Array.isArray(o)) return `[${o.map((v) => stableStringify(v)).join(',')}]`;
    const keys = Object.keys(o).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(',')}}`;
  };

  return computeChecksum(stableStringify(obj));
}
