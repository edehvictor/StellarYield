import { describe, it, expect } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import PortfolioReconcile from "../PortfolioReconcile";
import { toReconcileRows, type ReconcileResponse } from "../reconcileCauseRows";
import { RECONCILE_CAUSES } from "../../../../../shared/types/reconcileCause";

/**
 * Captured verbatim from `POST /api/portfolio/reconcile` — a wallet whose
 * projection has gone stale, that is missing one holding the chain reports,
 * and whose USDC has been renamed to USDC.e on-chain.
 */
const SERVER_RESPONSE: ReconcileResponse = {
  status: "partial",
  primaryCause: "STALE_SOURCE",
  isStale: true,
  causes: [
    {
      code: "STALE_SOURCE",
      detail:
        "Cached projection last advanced 360s ago, past the 300s freshness budget.",
      evidence: { staleDurationMs: 360_000, projectionVersion: 9, lastLedger: 41 },
    },
    {
      code: "SYMBOL_DRIFT",
      detail:
        "USDC is carried on-chain as USDC.e; both sides hold 1000, so only the asset code changed.",
      assetId: "USDC.e",
      vaultId: "vault-1",
      evidence: {
        chainAssetId: "USDC.e",
        cachedAssetId: "USDC",
        chainAmount: 1000,
        cachedAmount: 1000,
        canonicalAsset: "USDC",
      },
    },
    {
      code: "MISSING_HOLDING",
      detail:
        "Chain reports 250 EURC in vault-1, which the cached projection has no record of.",
      assetId: "EURC",
      vaultId: "vault-1",
      evidence: { chainAssetId: "EURC", chainAmount: 250 },
    },
  ],
};

/** Expands a vault group by its header, which may share text with table cells. */
const expandGroup = (vault: string) => {
  const header = Array.from(document.querySelectorAll("button.group-header")).find(
    (btn) => btn.querySelector(".group-vault")?.textContent === vault,
  );
  if (!header) throw new Error(`No group header for vault "${vault}"`);
  fireEvent.click(header);
};

describe("reconciliation causes in the portfolio UI", () => {
  describe("toReconcileRows", () => {
    it("maps every server cause to a row carrying its code and detail", () => {
      const rows = toReconcileRows(SERVER_RESPONSE);

      expect(rows).toHaveLength(3);
      expect(rows.map((r) => r.causeCode)).toEqual([
        "STALE_SOURCE",
        "SYMBOL_DRIFT",
        "MISSING_HOLDING",
      ]);
      expect(rows[1].causeDetail).toContain("only the asset code changed");
    });

    it("carries the server's severity rather than re-deriving one", () => {
      const rows = toReconcileRows(SERVER_RESPONSE);

      expect(rows[0].severity).toBe("warning"); // STALE_SOURCE
      expect(rows[2].severity).toBe("critical"); // MISSING_HOLDING
    });

    it("renders amounts only when the cause actually carries them", () => {
      const rows = toReconcileRows(SERVER_RESPONSE);

      expect(rows[0].observed).toBeNull(); // stale source is not position-specific
      expect(rows[0].delta).toBeNull();
      expect(rows[1].observed).toBe(1000);
      expect(rows[1].delta).toBe(0);
      expect(rows[2].expected).toBe("—"); // nothing cached — that is the point
      expect(rows[2].observed).toBe(250);
    });

    it("marks only the stale-source row as a stale checkpoint", () => {
      const rows = toReconcileRows(SERVER_RESPONSE);

      expect(rows[0].evidence?.isStaleCheckpoint).toBe(true);
      expect(rows[1].evidence?.isStaleCheckpoint).toBeFalsy();
    });

    it("returns no rows for a clean reconciliation", () => {
      expect(
        toReconcileRows({ status: "success", primaryCause: null, causes: [] }),
      ).toEqual([]);
    });
  });

  describe("rendering", () => {
    it("labels each row with its cause", () => {
      const { container } = render(
        <PortfolioReconcile rows={toReconcileRows(SERVER_RESPONSE)} />,
      );
      expandGroup("vault-1");
      expandGroup("—");

      // Scoped to the badges: the cause filter carries the same words.
      const labels = Array.from(container.querySelectorAll("[data-cause]")).map((el) =>
        el.textContent?.split(RECONCILE_CAUSES.SYMBOL_DRIFT.title)[0],
      );
      expect(labels).toHaveLength(3);

      expect(container.querySelector('[data-cause="SYMBOL_DRIFT"]')?.textContent).toContain(
        "Symbol drift",
      );
      expect(container.querySelector('[data-cause="MISSING_HOLDING"]')?.textContent).toContain(
        "Missing holding",
      );
      expect(container.querySelector('[data-cause="STALE_SOURCE"]')?.textContent).toContain(
        "Stale source",
      );
    });

    it("distinguishes missing data from symbol drift by category, not just label", () => {
      const { container } = render(
        <PortfolioReconcile rows={toReconcileRows(SERVER_RESPONSE)} />,
      );
      expandGroup("vault-1");

      const drift = container.querySelector('[data-cause="SYMBOL_DRIFT"]')!;
      const missing = container.querySelector('[data-cause="MISSING_HOLDING"]')!;

      expect(drift.getAttribute("data-cause-category")).toBe("symbol-drift");
      expect(missing.getAttribute("data-cause-category")).toBe("missing-data");
      expect(drift.className).not.toBe(missing.className);
      expect(drift.className).toContain("cause-symbol-drift");
      expect(missing.className).toContain("cause-missing-data");
    });

    it("shows the remediation on hover so an operator knows what to do next", () => {
      const { container } = render(
        <PortfolioReconcile rows={toReconcileRows(SERVER_RESPONSE)} />,
      );
      expandGroup("vault-1");

      const drift = container.querySelector('[data-cause="SYMBOL_DRIFT"]')!;
      expect(drift.getAttribute("title")).toContain(RECONCILE_CAUSES.SYMBOL_DRIFT.remediation);
      expect(drift.getAttribute("title")).toContain("alias map");

      const missing = container.querySelector('[data-cause="MISSING_HOLDING"]')!;
      expect(missing.getAttribute("title")).toContain("Replay the indexer");
    });

    it("filters to missing data without showing symbol drift", () => {
      const { container } = render(
        <PortfolioReconcile rows={toReconcileRows(SERVER_RESPONSE)} />,
      );

      fireEvent.change(screen.getByLabelText("Filter by cause"), {
        target: { value: "missing-data" },
      });
      expandGroup("vault-1");

      expect(container.querySelector('[data-cause="MISSING_HOLDING"]')).toBeTruthy();
      expect(container.querySelector('[data-cause="SYMBOL_DRIFT"]')).toBeNull();
      expect(container.querySelector('[data-cause="STALE_SOURCE"]')).toBeNull();
    });

    it("filters to symbol drift without showing missing data", () => {
      const { container } = render(
        <PortfolioReconcile rows={toReconcileRows(SERVER_RESPONSE)} />,
      );

      fireEvent.change(screen.getByLabelText("Filter by cause"), {
        target: { value: "symbol-drift" },
      });
      expandGroup("vault-1");

      expect(container.querySelector('[data-cause="SYMBOL_DRIFT"]')).toBeTruthy();
      expect(container.querySelector('[data-cause="MISSING_HOLDING"]')).toBeNull();
    });

    it("filters to the stale source, which sits in its own group", () => {
      const { container } = render(
        <PortfolioReconcile rows={toReconcileRows(SERVER_RESPONSE)} />,
      );

      fireEvent.change(screen.getByLabelText("Filter by cause"), {
        target: { value: "stale-source" },
      });
      expandGroup("—");

      expect(container.querySelector('[data-cause="STALE_SOURCE"]')).toBeTruthy();
      expect(container.querySelector('[data-cause="SYMBOL_DRIFT"]')).toBeNull();
    });

    it("keeps rows without a cause code rendering as before", () => {
      render(
        <PortfolioReconcile
          rows={[
            {
              asset: "USDC",
              vault: "Blend",
              expected: 100,
              observed: 100,
              delta: 0,
              severity: "ok",
              anomalyType: "matched",
              status: "confirmed",
            },
          ]}
        />,
      );
      expandGroup("Blend");

      const row = screen.getByText("USDC").closest("tr")!;
      expect(within(row).getByText("—")).toBeTruthy();
    });
  });
});
