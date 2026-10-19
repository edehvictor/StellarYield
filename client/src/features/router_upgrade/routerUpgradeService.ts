import type {
  RouterUpgradeDryRunInput,
  RouterUpgradeDryRunResult,
  RouterStatusResponse,
} from "./types";

export async function performRouterUpgradeDryRun(
  input: RouterUpgradeDryRunInput
): Promise<RouterUpgradeDryRunResult> {
  const response = await fetch("/api/router-upgrade/dry-run", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input),
  });

  const data = (await response.json()) as RouterUpgradeDryRunResult;

  if (!response.ok && !data.error) {
    throw new Error(
      `Dry-run request failed with status ${response.status}: ${response.statusText}`
    );
  }

  return data;
}

export async function fetchRouterStatus(): Promise<RouterStatusResponse> {
  const response = await fetch("/api/router-upgrade/status");
  if (!response.ok) {
    throw new Error(`Failed to fetch router status: ${response.statusText}`);
  }
  return response.json();
}
