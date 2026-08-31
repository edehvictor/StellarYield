/**
 * Hook for centralized notification state management
 * Provides single source of truth for unread counts across all notification surfaces
 */

import { useState, useCallback, useEffect, useRef } from "react";

export interface Notification {
  id: string;
  walletAddress: string;
  type: string; // DEPOSIT, WITHDRAWAL, ANNOUNCEMENT, HARVEST
  title: string;
  message: string;
  isRead: boolean;
  createdAt: string;
}

export interface NotificationState {
  notifications: Notification[];
  unreadCount: number;
  isLoading: boolean;
  error: string | null;
}

export interface NotificationActions {
  fetchNotifications: (walletAddress: string) => Promise<void>;
  markAsRead: (notificationId: string) => Promise<void>;
  markAllAsRead: (walletAddress: string) => Promise<void>;
  refreshNotifications: (walletAddress: string) => Promise<void>;
  clearAllNotifications: (walletAddress: string) => Promise<void>;
}

const API_BASE = import.meta.env.VITE_API_URL || "http://localhost:3001/api";

export function useNotificationState(): [NotificationState, NotificationActions] {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Track if initial fetch has been done per wallet
  const fetchedWalletsRef = useRef<Set<string>>(new Set());

  /**
   * Compute unread count from notifications array
   * Single source of truth for unread state
   */
  const computeUnreadCount = useCallback((notifs: Notification[]): number => {
    return notifs.filter((n) => !n.isRead).length;
  }, []);

  /**
   * Fetch all notifications for a user
   */
  const fetchNotifications = useCallback(
    async (walletAddress: string) => {
      if (!walletAddress) return;

      setIsLoading(true);
      setError(null);

      try {
        const response = await fetch(`${API_BASE}/notifications/${walletAddress}`);
        if (!response.ok) throw new Error("Failed to fetch notifications");

        const data: Notification[] = await response.json();
        setNotifications(data);
        const count = computeUnreadCount(data);
        setUnreadCount(count);
        fetchedWalletsRef.current.add(walletAddress);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        setError(message);
      } finally {
        setIsLoading(false);
      }
    },
    [computeUnreadCount]
  );

  /**
   * Mark a single notification as read
   * Updates local state immediately (optimistic update)
   */
  const markAsRead = useCallback(
    async (notificationId: string) => {
      // Optimistic update
      setNotifications((prev) => {
        const updated = prev.map((n) =>
          n.id === notificationId ? { ...n, isRead: true } : n
        );
        setUnreadCount(computeUnreadCount(updated));
        return updated;
      });

      try {
        const response = await fetch(`${API_BASE}/notifications/${notificationId}/read`, {
          method: "PATCH",
        });
        if (!response.ok) {
          throw new Error("Failed to mark as read");
        }
      } catch (err) {
        // Revert optimistic update on error
        setNotifications((prev) => {
          const updated = prev.map((n) =>
            n.id === notificationId ? { ...n, isRead: false } : n
          );
          setUnreadCount(computeUnreadCount(updated));
          return updated;
        });
        const message = err instanceof Error ? err.message : "Unknown error";
        setError(message);
      }
    },
    [computeUnreadCount]
  );

  /**
   * Mark all notifications as read for a user
   */
  const markAllAsRead = useCallback(
    async (walletAddress: string) => {
      if (!walletAddress) return;

      // Optimistic update
      setNotifications((prev) =>
        prev.map((n) => ({ ...n, isRead: true }))
      );
      setUnreadCount(0);

      try {
        const response = await fetch(`${API_BASE}/notifications/${walletAddress}/read-all`, {
          method: "PATCH",
        });
        if (!response.ok) {
          throw new Error("Failed to mark all as read");
        }
      } catch (err) {
        // Revert optimistic update on error
        const count = computeUnreadCount(notifications);
        setUnreadCount(count);
        const message = err instanceof Error ? err.message : "Unknown error";
        setError(message);
      }
    },
    [computeUnreadCount, notifications]
  );

  /**
   * Refresh notifications from server
   * Maintains read state, doesn't restore already-read items
   */
  const refreshNotifications = useCallback(
    async (walletAddress: string) => {
      if (!walletAddress) return;

      try {
        const response = await fetch(`${API_BASE}/notifications/${walletAddress}`);
        if (!response.ok) throw new Error("Failed to refresh notifications");

        const data: Notification[] = await response.json();
        setNotifications(data);
        const count = computeUnreadCount(data);
        setUnreadCount(count);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        setError(message);
      }
    },
    [computeUnreadCount]
  );

  /**
   * Clear all notifications for a user
   */
  const clearAllNotifications = useCallback(
    async (walletAddress: string) => {
      if (!walletAddress) return;

      setNotifications([]);
      setUnreadCount(0);

      try {
        const response = await fetch(`${API_BASE}/notifications/${walletAddress}`, {
          method: "DELETE",
        });
        if (!response.ok) {
          throw new Error("Failed to clear notifications");
        }
      } catch (err) {
        // Revert on error
        await fetchNotifications(walletAddress);
        const message = err instanceof Error ? err.message : "Unknown error";
        setError(message);
      }
    },
    [fetchNotifications]
  );

  const state: NotificationState = {
    notifications,
    unreadCount,
    isLoading,
    error,
  };

  const actions: NotificationActions = {
    fetchNotifications,
    markAsRead,
    markAllAsRead,
    refreshNotifications,
    clearAllNotifications,
  };

  return [state, actions];
}
