import { useRef, useState, type ChangeEvent } from "react";
import { Upload } from "lucide-react";
import {
  PORTFOLIO_IMPORT_FAILURES,
  validatePortfolioImportCsv,
  type PortfolioImportFailure,
  type PortfolioImportPreview,
} from "../../../../shared/types/portfolioImport";

/** Row issues shown before collapsing the rest into a count. */
const MAX_VISIBLE_ISSUES = 5;

type ImportState =
  | { status: "idle" }
  | { status: "loading"; fileName: string }
  | { status: "failure"; fileName: string; error: PortfolioImportFailure }
  | { status: "success"; fileName: string; preview: PortfolioImportPreview };

function formatUsd(value: number): string {
  return value.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

/**
 * Validates an external holdings CSV (#1340) with the same rules the API uses,
 * and previews what would be imported: file-level failures show a single
 * stable reason, row-level issues are listed by row number.
 */
export default function PortfolioImport() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<ImportState>({ status: "idle" });

  const handleFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // Allow re-selecting the same file after fixing it.
    event.target.value = "";
    if (!file) return;

    setState({ status: "loading", fileName: file.name });
    let text: string;
    try {
      text = await file.text();
    } catch {
      setState({
        status: "failure",
        fileName: file.name,
        error: {
          code: "IMPORT_UNREADABLE_FILE",
          message: PORTFOLIO_IMPORT_FAILURES.IMPORT_UNREADABLE_FILE.message,
        },
      });
      return;
    }

    const result = validatePortfolioImportCsv(text);
    setState(
      result.ok
        ? { status: "success", fileName: file.name, preview: result.preview }
        : { status: "failure", fileName: file.name, error: result.error },
    );
  };

  return (
    <div className="flex flex-col items-end gap-2">
      <input
        ref={inputRef}
        type="file"
        accept=".csv,text/csv"
        onChange={(event) => void handleFile(event)}
        className="hidden"
        data-testid="portfolio-import-input"
      />
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={state.status === "loading"}
        className="btn-secondary flex items-center gap-2 text-sm"
      >
        <Upload size={14} />
        Import CSV
      </button>

      {state.status === "loading" ? (
        <p className="text-right text-sm text-gray-400" role="status">
          Validating {state.fileName}…
        </p>
      ) : null}

      {state.status === "failure" ? (
        <div className="text-right text-sm text-red-400" role="alert">
          <p>{state.error.message}</p>
          {state.error.details?.missingColumns ? (
            <p>Missing: {state.error.details.missingColumns.join(", ")}</p>
          ) : null}
        </div>
      ) : null}

      {state.status === "success" ? (
        <div className="w-full max-w-sm rounded-2xl border border-white/10 bg-white/5 p-3 text-sm" role="status">
          {state.preview.summary.validRows === 0 ? (
            <p className="text-orange-300">No valid holdings in {state.fileName}.</p>
          ) : (
            <p className="text-gray-200">
              {state.preview.summary.validRows} of {state.preview.summary.totalRows} holdings ready to import ·{" "}
              {formatUsd(state.preview.summary.totalCurrentValueUsd)} current value
            </p>
          )}
          {state.preview.issues.length > 0 ? (
            <ul className="mt-2 space-y-1 text-orange-300" aria-label="Import issues">
              {state.preview.issues.slice(0, MAX_VISIBLE_ISSUES).map((issue) => (
                <li key={`${issue.row}-${issue.column ?? "row"}-${issue.code}`}>
                  Row {issue.row}: {issue.message}
                </li>
              ))}
              {state.preview.issues.length > MAX_VISIBLE_ISSUES ? (
                <li className="text-gray-400">
                  +{state.preview.issues.length - MAX_VISIBLE_ISSUES} more issues
                </li>
              ) : null}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
