export const DEFAULT_DRIFT_WINDOW_MS = 60 * 60 * 1000; // 1 hour

export interface DriftAlertInput {
  portfolioId: string;
  asset: string;
  severity: string;
  /** Drift cause. If your alerts have no cause field, `message` is used. */
  cause?: string;
  message?: string;
  createdAt: string | Date;
}

export type DriftDigestItem<T extends DriftAlertInput = DriftAlertInput> =
  | {
      kind: "group";
      portfolioId: string;
      asset: string;
      severity: string;
      cause: string;
      count: number;
      firstAt: string;
      latestAt: string;
      latestAlert: T;
    }
  | { kind: "single"; alert: T };

export interface DriftDigest<T extends DriftAlertInput = DriftAlertInput> {
  items: DriftDigestItem<T>[];
  summary: {
    totalAlerts: number;
    digestItems: number;
    groupedItems: number;
    collapsedAlerts: number;
  };
}

const norm = (v: unknown) => String(v ?? "").trim().toLowerCase();

/**
 * Groups repeated drift alerts by portfolio + asset + severity + cause.
 * A group holds alerts within `windowMs` of the group's first alert;
 * an alert after that starts a new group. Distinct causes never merge.
 * Does not mutate the input. Items are ordered newest-first by latest timestamp.
 */
export function groupDriftAlerts<T extends DriftAlertInput>(
  alerts: T[],
  opts: { windowMs?: number } = {},
): DriftDigest<T> {
  const windowMs = opts.windowMs ?? DEFAULT_DRIFT_WINDOW_MS;

  const valid: { alert: T; t: number }[] = [];
  const invalid: T[] = [];
  for (const alert of alerts) {
    const t = new Date(alert.createdAt).getTime();
    if (Number.isFinite(t)) valid.push({ alert, t });
    else invalid.push(alert);
  }
  valid.sort((a, b) => a.t - b.t);

  type G = { alert: T; key: string; firstMs: number; latestMs: number; count: number; latestAlert: T };
  const open = new Map<string, G>();
  const groups: G[] = [];

  for (const { alert, t } of valid) {
    const cause = alert.cause ?? alert.message ?? "";
    const key = [alert.portfolioId, alert.asset, alert.severity, cause].map(norm).join("\u0000");
    const cur = open.get(key);
    if (cur && t - cur.firstMs <= windowMs) {
      cur.count += 1;
      cur.latestMs = t;
      cur.latestAlert = alert;
    } else {
      const g: G = { alert, key, firstMs: t, latestMs: t, count: 1, latestAlert: alert };
      open.set(key, g);
      groups.push(g);
    }
  }

  const dated = groups
    .map((g) => ({
      latestMs: g.latestMs,
      item:
        g.count > 1
          ? ({
              kind: "group",
              portfolioId: g.alert.portfolioId,
              asset: g.alert.asset,
              severity: g.alert.severity,
              cause: g.alert.cause ?? g.alert.message ?? "",
              count: g.count,
              firstAt: new Date(g.firstMs).toISOString(),
              latestAt: new Date(g.latestMs).toISOString(),
              latestAlert: g.latestAlert,
            } as DriftDigestItem<T>)
          : ({ kind: "single", alert: g.alert } as DriftDigestItem<T>),
    }))
    .sort((a, b) => b.latestMs - a.latestMs);

  const items: DriftDigestItem<T>[] = [
    ...dated.map((d) => d.item),
    ...invalid.map((alert) => ({ kind: "single", alert }) as DriftDigestItem<T>),
  ];
  const groupedItems = items.filter((i) => i.kind === "group").length;

  return {
    items,
    summary: {
      totalAlerts: alerts.length,
      digestItems: items.length,
      groupedItems,
      collapsedAlerts: alerts.length - items.length,
    },
  };
}

/** One-line text for text/email digests, e.g. "p1 · XLM · high: cause (x4, latest 2026-...)". */
export function describeDriftDigestItem(item: DriftDigestItem): string {
  if (item.kind === "single") {
    const a = item.alert;
    return `${a.portfolioId} · ${a.asset} · ${a.severity}: ${a.cause ?? a.message ?? ""}`;
  }
  return `${item.portfolioId} · ${item.asset} · ${item.severity}: ${item.cause} (x${item.count}, latest ${item.latestAt})`;
}