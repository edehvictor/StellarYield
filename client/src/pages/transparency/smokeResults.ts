export interface SmokeCheckResult {
  label: string;
  url: string;
  status: "pass" | "fail";
  httpCode: number;
  message?: string;
}

export interface SmokeRunResult {
  timestamp: string;
  frontendUrl: string;
  backendUrl: string;
  status: "pass" | "fail";
  checks: SmokeCheckResult[];
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateSmokeCheck(item: unknown): SmokeCheckResult | null {
  if (!isPlainRecord(item)) return null;
  if (
    typeof item.label !== "string" ||
    !item.label.trim() ||
    typeof item.url !== "string" ||
    !item.url.trim() ||
    (item.status !== "pass" && item.status !== "fail") ||
    typeof item.httpCode !== "number" ||
    !Number.isFinite(item.httpCode) ||
    item.httpCode < 0
  ) {
    return null;
  }
  if (item.message !== undefined && typeof item.message !== "string") {
    return null;
  }
  return {
    label: item.label.trim(),
    url: item.url.trim(),
    status: item.status,
    httpCode: Math.floor(item.httpCode),
    ...(item.message !== undefined ? { message: item.message } : {}),
  };
}

export function parseSmokeRunResult(raw: unknown): SmokeRunResult | null {
  try {
    const parsed: unknown =
      typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!isPlainRecord(parsed)) {
      return null;
    }
    if (
      typeof parsed.timestamp !== "string" ||
      !parsed.timestamp.trim() ||
      !Number.isFinite(Date.parse(parsed.timestamp)) ||
      typeof parsed.frontendUrl !== "string" ||
      !parsed.frontendUrl.trim() ||
      typeof parsed.backendUrl !== "string" ||
      !parsed.backendUrl.trim() ||
      (parsed.status !== "pass" && parsed.status !== "fail") ||
      !Array.isArray(parsed.checks)
    ) {
      return null;
    }

    const checks: SmokeCheckResult[] = [];
    for (const check of parsed.checks) {
      const validCheck = validateSmokeCheck(check);
      if (!validCheck) return null;
      checks.push(validCheck);
    }

    return {
      timestamp: parsed.timestamp.trim(),
      frontendUrl: parsed.frontendUrl.trim(),
      backendUrl: parsed.backendUrl.trim(),
      status: parsed.status,
      checks,
    };
  } catch {
    return null;
  }
}

export function parseSmokeHistory(rawHistory: unknown): SmokeRunResult[] {
  if (rawHistory === null || rawHistory === undefined || rawHistory === "") {
    return [];
  }
  try {
    const parsed: unknown =
      typeof rawHistory === "string" ? JSON.parse(rawHistory) : rawHistory;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .map((entry) => parseSmokeRunResult(entry))
      .filter((entry): entry is SmokeRunResult => entry !== null);
  } catch {
    return [];
  }
}
