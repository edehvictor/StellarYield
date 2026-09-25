import type { DriftAlertEvent, DriftDigestItem } from './types';

const DEFAULT_WINDOW_MS = 86_400_000; // 24 hours, matches EventClusterer's default

/**
 * Builds the grouping key: same portfolio + same asset + same severity +
  * same drift cause. Distinct causes (overweight vs underweight vs recovered)
   * are intentionally kept out of this key's "sameness" — see below.
    */
    function groupKey(e: DriftAlertEvent): string {
      return `${e.portfolioId}|${e.assetId}|${e.severity}|${e.driftCause}`;
      }

      /**
       * Groups repeated portfolio drift alerts into digest items.
        *
         * - Alerts are grouped only when portfolioId, assetId, severity, and
          *   driftCause all match — distinct drift causes (e.g. overweight vs.
           *   underweight) always remain separate digest items, even for the same
            *   portfolio/asset.
             * - Within a matching group, alerts are further split into time-window
              *   buckets: consecutive alerts stay in the same bucket as long as each
               *   new alert falls within `windowMs` of the bucket's first alert.
                * - Each resulting bucket becomes one DriftDigestItem, with
                 *   occurrenceCount = number of alerts merged, and latestTriggeredAt set
                  *   to the maximum triggeredAt in the bucket (never lost, even if alerts
                   *   arrive out of order).
                    *
                     * @param alerts   - Raw drift alert events (any order).
                      * @param windowMs - Grouping time window in ms (default 24h).
                       */
                       export function groupDriftAlerts(
                         alerts: DriftAlertEvent[],
                           windowMs: number = DEFAULT_WINDOW_MS,
                           ): DriftDigestItem[] {
                             if (alerts.length === 0) return [];

                               // Bucket by identity key first.
                                 const byKey = new Map<string, DriftAlertEvent[]>();
                                   for (const alert of alerts) {
                                       const key = groupKey(alert);
                                           if (!byKey.has(key)) byKey.set(key, []);
                                               byKey.get(key)!.push(alert);
                                                 }

                                                   const items: DriftDigestItem[] = [];

                                                     for (const group of byKey.values()) {
                                                         // Sort ascending by triggeredAt so windowing is deterministic.
                                                             const sorted = [...group].sort(
                                                                   (a, b) => new Date(a.triggeredAt).getTime() - new Date(b.triggeredAt).getTime(),
                                                                       );

                                                                           let bucket: DriftAlertEvent[] = [];
                                                                               let bucketStart = -Infinity;

                                                                                   const flush = () => {
                                                                                         if (bucket.length === 0) return;
                                                                                               const latest = bucket.reduce((max, e) =>
                                                                                                       new Date(e.triggeredAt).getTime() > new Date(max.triggeredAt).getTime() ? e : max,
                                                                                                             );
                                                                                                                   const first = bucket[0];
                                                                                                                         items.push({
                                                                                                                                 portfolioId: first.portfolioId,
                                                                                                                                         assetId: first.assetId,
                                                                                                                                                 severity: first.severity,
                                                                                                                                                         driftCause: first.driftCause,
                                                                                                                                                                 occurrenceCount: bucket.length,
                                                                                                                                                                         latestTriggeredAt: latest.triggeredAt,
                                                                                                                                                                                 latestMessage: latest.message,
                                                                                                                                                                                         alertIds: bucket.map((e) => e.eventId),
                                                                                                                                                                                               });
                                                                                                                                                                                                     bucket = [];
                                                                                                                                                                                                         };

                                                                                                                                                                                                             for (const alert of sorted) {
                                                                                                                                                                                                                   const ts = new Date(alert.triggeredAt).getTime();
                                                                                                                                                                                                                         if (bucket.length === 0) {
                                                                                                                                                                                                                                 bucket = [alert];
                                                                                                                                                                                                                                         bucketStart = ts;
                                                                                                                                                                                                                                                 continue;
                                                                                                                                                                                                                                                       }
                                                                                                                                                                                                                                                             if (ts - bucketStart <= windowMs) {
                                                                                                                                                                                                                                                                     bucket.push(alert);
                                                                                                                                                                                                                                                                           } else {
                                                                                                                                                                                                                                                                                   flush();
                                                                                                                                                                                                                                                                                           bucket = [alert];
                                                                                                                                                                                                                                                                                                   bucketStart = ts;
                                                                                                                                                                                                                                                                                                         }
                                                                                                                                                                                                                                                                                                             }
                                                                                                                                                                                                                                                                                                                 flush();
                                                                                                                                                                                                                                                                                                                   }

                                                                                                                                                                                                                                                                                                                     return items;
                                                                                                                                                                                                                                                                                                                     }