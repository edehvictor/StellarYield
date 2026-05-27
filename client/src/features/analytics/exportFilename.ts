/**
 * Client-side standardized export filenames, mirroring the server's
 * `createExportFilename` convention:
 *
 *   stellaryield-<reportType>-<environment>-<YYYY-MM-DD>.<ext>
 *
 * Keeps downloaded files predictable and filesystem-safe across the app.
 */

/** Replace unsafe characters with a hyphen and collapse runs of dots. */
export function sanitizeFilenameSegment(value: string): string {
  return String(value)
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/^[-.]+|[-.]+$/g, "");
}

/** Resolve the current frontend environment for filename tagging. */
function currentEnvironment(): string {
  const env =
    (import.meta.env.VITE_STELLAR_NETWORK as string | undefined) ??
    (import.meta.env.MODE as string | undefined) ??
    "production";
  return sanitizeFilenameSegment(env.toLowerCase()) || "production";
}

/**
 * Build a standardized, filesystem-safe export filename.
 *
 * @param reportType - Logical report name, e.g. "snapshot" or "tax-report".
 * @param extension - File extension without the dot (default "json").
 */
export function buildExportFilename(
  reportType: string,
  extension = "json",
): string {
  const type = sanitizeFilenameSegment(reportType) || "export";
  const ext = sanitizeFilenameSegment(extension) || "json";
  const date = new Date().toISOString().split("T")[0];
  return `stellaryield-${type}-${currentEnvironment()}-${date}.${ext}`;
}
