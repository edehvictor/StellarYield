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

export function parseSmokeRunResult(raw: string): SmokeRunResult | null {
  try {
    const parsed = JSON.parse(raw) as Partial<SmokeRunResult>;
    if (
      typeof parsed.timestamp !== "string" ||
      typeof parsed.frontendUrl !== "string" ||
      typeof parsed.backendUrl !== "string" ||
      (parsed.status !== "pass" && parsed.status !== "fail") ||
      !Array.isArray(parsed.checks)
    ) {
      return null;
    }
    return parsed as SmokeRunResult;
  } catch {
    return null;
  }
}
