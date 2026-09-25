const BEARER_TOKEN_RE = /Bearer\s+[a-zA-Z0-9_\-.]+/gi;
const KEY_PARAM_RE = /\b(api_key|apikey|key)=[a-zA-Z0-9_\-.]+/gi;
const STELLAR_SECRET_RE = /^S[A-Z0-9]{55}$/;

const REDACTED = "[REDACTED]";

function redactString(value: string): string {
  if (STELLAR_SECRET_RE.test(value)) {
    return REDACTED;
  }
  return value
    .replace(BEARER_TOKEN_RE, `Bearer ${REDACTED}`)
    .replace(KEY_PARAM_RE, (_match, param: string) => `${param}=${REDACTED}`);
}

/**
 * Deep-walks a value (string/array/object), redacting Stellar secret keys and
 * common credential patterns (Bearer tokens, `key=`/`api_key=`/`apikey=`
 * query params) before it is persisted or hashed into an audit record.
 */
export function redactSensitive<T>(value: T): T {
  if (typeof value === "string") {
    return redactString(value) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactSensitive(item)) as unknown as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = redactSensitive(val);
    }
    return out as unknown as T;
  }
  return value;
}
