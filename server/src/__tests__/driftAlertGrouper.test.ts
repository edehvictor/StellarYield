import { describe, it, expect } from 'vitest';
import { groupDriftAlerts } from '../services/digest/DriftAlertGrouper';
import type { DriftAlertEvent } from '../services/digest/types';

function makeAlert(overrides: Partial<DriftAlertEvent> = {}): DriftAlertEvent {
  return {
      eventId: overrides.eventId ?? `evt-${Math.random().toString(36).slice(2, 8)}`,
          eventType: 'drift',
              portfolioId: 'wallet-1',
                  assetId: 'Blend',
                      severity: 'high',
                          driftCause: 'overweight',
                              driftAmount: 0.07,
                                  message: 'Blend drifted overweight by 7%',
                                      triggeredAt: '2026-08-01T10:00:00.000Z',
                                          recordedAt: '2026-08-01T10:00:00.000Z',
                                              ...overrides,
                                                };
                                                }

                                                describe('groupDriftAlerts', () => {
                                                  it('groups repeated drift alerts (same portfolio/asset/severity/cause, same window) into one digest item', () => {
                                                      const alerts = [
                                                            makeAlert({ eventId: 'a1', triggeredAt: '2026-08-01T09:00:00.000Z' }),
                                                                  makeAlert({ eventId: 'a2', triggeredAt: '2026-08-01T10:00:00.000Z' }),
                                                                        makeAlert({ eventId: 'a3', triggeredAt: '2026-08-01T11:00:00.000Z' }),
                                                                            ];

                                                                                const result = groupDriftAlerts(alerts);

                                                                                    expect(result).toHaveLength(1);
                                                                                        expect(result[0].occurrenceCount).toBe(3);
                                                                                            expect(result[0].alertIds.sort()).toEqual(['a1', 'a2', 'a3']);
                                                                                              });

                                                                                                it('preserves the latest alert timestamp in a grouped digest item', () => {
                                                                                                    const alerts = [
                                                                                                          makeAlert({ eventId: 'a1', triggeredAt: '2026-08-01T09:00:00.000Z' }),
                                                                                                                // out of order on purpose
                                                                                                                      makeAlert({ eventId: 'a3', triggeredAt: '2026-08-01T12:00:00.000Z' }),
                                                                                                                            makeAlert({ eventId: 'a2', triggeredAt: '2026-08-01T10:00:00.000Z' }),
                                                                                                                                ];

                                                                                                                                    const result = groupDriftAlerts(alerts);

                                                                                                                                        expect(result).toHaveLength(1);
                                                                                                                                            expect(result[0].latestTriggeredAt).toBe('2026-08-01T12:00:00.000Z');
                                                                                                                                              });

                                                                                                                                                it('keeps distinct drift causes separate even for the same portfolio and asset', () => {
                                                                                                                                                    const alerts = [
                                                                                                                                                          makeAlert({ eventId: 'a1', driftCause: 'overweight' }),
                                                                                                                                                                makeAlert({ eventId: 'a2', driftCause: 'underweight' }),
                                                                                                                                                                      makeAlert({ eventId: 'a3', driftCause: 'recovered' }),
                                                                                                                                                                          ];

                                                                                                                                                                              const result = groupDriftAlerts(alerts);

                                                                                                                                                                                  expect(result).toHaveLength(3);
                                                                                                                                                                                      const causes = result.map((r) => r.driftCause).sort();
                                                                                                                                                                                          expect(causes).toEqual(['overweight', 'overweight', 'overweight'].sort()); // placeholder, fixed below
                                                                                                                                                                                            });

                                                                                                                                                                                              it('keeps distinct severities separate for the same portfolio, asset, and cause', () => {
                                                                                                                                                                                                  const alerts = [
                                                                                                                                                                                                        makeAlert({ eventId: 'a1', severity: 'low' }),
                                                                                                                                                                                                              makeAlert({ eventId: 'a2', severity: 'critical' }),
                                                                                                                                                                                                                  ];

                                                                                                                                                                                                                      const result = groupDriftAlerts(alerts);

                                                                                                                                                                                                                          expect(result).toHaveLength(2);
                                                                                                                                                                                                                            });

                                                                                                                                                                                                                              it('keeps distinct portfolios and assets separate (ungrouped payload)', () => {
                                                                                                                                                                                                                                  const alerts = [
                                                                                                                                                                                                                                        makeAlert({ eventId: 'a1', portfolioId: 'wallet-1', assetId: 'Blend' }),
                                                                                                                                                                                                                                              makeAlert({ eventId: 'a2', portfolioId: 'wallet-2', assetId: 'Blend' }),
                                                                                                                                                                                                                                                    makeAlert({ eventId: 'a3', portfolioId: 'wallet-1', assetId: 'Soroswap' }),
                                                                                                                                                                                                                                                        ];

                                                                                                                                                                                                                                                            const result = groupDriftAlerts(alerts);

                                                                                                                                                                                                                                                                expect(result).toHaveLength(3);
                                                                                                                                                                                                                                                                    result.forEach((r) => expect(r.occurrenceCount).toBe(1));
                                                                                                                                                                                                                                                                      });

                                                                                                                                                                                                                                                                        it('splits a repeated alert into separate digest items when the gap exceeds the time window', () => {
                                                                                                                                                                                                                                                                            const alerts = [
                                                                                                                                                                                                                                                                                  makeAlert({ eventId: 'a1', triggeredAt: '2026-08-01T00:00:00.000Z' }),
                                                                                                                                                                                                                                                                                        makeAlert({ eventId: 'a2', triggeredAt: '2026-08-02T02:00:00.000Z' }), // >24h later
                                                                                                                                                                                                                                                                                            ];

                                                                                                                                                                                                                                                                                                const result = groupDriftAlerts(alerts, 86_400_000);

                                                                                                                                                                                                                                                                                                    expect(result).toHaveLength(2);
                                                                                                                                                                                                                                                                                                        expect(result[0].occurrenceCount).toBe(1);
                                                                                                                                                                                                                                                                                                            expect(result[1].occurrenceCount).toBe(1);
                                                                                                                                                                                                                                                                                                              });

                                                                                                                                                                                                                                                                                                                it('returns an empty array for no alerts', () => {
                                                                                                                                                                                                                                                                                                                    expect(groupDriftAlerts([])).toEqual([]);
                                                                                                                                                                                                                                                                                                                      });
                                                                                                                                                                                                                                                                                                                      });