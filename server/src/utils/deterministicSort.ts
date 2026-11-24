export interface NotificationLike {
  id: string;
  createdAt: Date | string | number;
  isRead?: boolean;
  type?: string;
  status?: string;
  triggeredAt?: Date | string | number | null;
  priority?: number;
  severity?: string | number;
}

function toTime(value: Date | string | number | null | undefined): number {
  if (value == null) return 0;
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function severityRank(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const normalized = String(value ?? "").toLowerCase();
  switch (normalized) {
    case "critical":
    case "fatal":
    case "emergency":
      return 4;
    case "high":
    case "error":
    case "major":
      return 3;
    case "medium":
    case "warning":
    case "warn":
      return 2;
    case "low":
    case "info":
    case "informational":
      return 1;
    default:
      return 0;
  }
}

function statusRank(value: unknown): number {
  const normalized = String(value ?? "").toLowerCase();
  switch (normalized) {
    case "triggered":
    case "critical":
      return 4;
    case "active":
    case "unread":
    case "open":
      return 3;
    case "pending":
      return 2;
    case "read":
    case "resolved":
    case "completed":
      return 1;
    case "deleted":
    case "closed":
    case "cancelled":
    case "canceled":
      return 0;
    default:
      return 0;
  }
}

function compareStrings(a: unknown, b: unknown): number {
  return String(a ?? "").localeCompare(String(b ?? ""), "en", {
    numeric: true,
    sensitivity: "base",
  });
}

export function compareNotificationsDeterministically<
  T extends NotificationLike,
>(a: T, b: T): number {
  const unreadA = a.isRead === false ? 1 : 0;
  const unreadB = b.isRead === false ? 1 : 0;
  if (unreadA !== unreadB) return unreadB - unreadA;

  const createdDiff = toTime(b.createdAt) - toTime(a.createdAt);
  if (createdDiff !== 0) return createdDiff;

  const triggeredDiff = toTime(b.triggeredAt) - toTime(a.triggeredAt);
  if (triggeredDiff !== 0) return triggeredDiff;

  const statusDiff = statusRank(b.status) - statusRank(a.status);
  if (statusDiff !== 0) return statusDiff;

  const severityDiff = severityRank(b.severity) - severityRank(a.severity);
  if (severityDiff !== 0) return severityDiff;

  const priorityA = typeof a.priority === "number" ? a.priority : 0;
  const priorityB = typeof b.priority === "number" ? b.priority : 0;
  if (priorityA !== priorityB) return priorityB - priorityA;

  const typeDiff = compareStrings(a.type, b.type);
  if (typeDiff !== 0) return typeDiff;

  return compareStrings(a.id, b.id);
}

export function sortNotificationsDeterministically<T extends NotificationLike>(
  items: readonly T[],
): T[] {
  return [...items].sort(compareNotificationsDeterministically);
}
