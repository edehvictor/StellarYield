/**
 * NotificationContext: Global state provider for notifications
 * Ensures unread counts are consistent across all notification surfaces
 */

import React, { createContext, useContext, useEffect, useCallback } from "react";
import { useNotificationState, type NotificationState, type NotificationActions } from "../hooks/useNotificationState";
import { useWallet } from "./useWallet";

interface NotificationContextValue {
  state: NotificationState;
  actions: NotificationActions;
}

const NotificationContext = createContext<NotificationContextValue | undefined>(undefined);

export function NotificationProvider({ children }: { children: React.ReactNode }) {
  const [state, actions] = useNotificationState();
  const { walletAddress } = useWallet();

  // Fetch notifications when wallet changes
  useEffect(() => {
    if (walletAddress) {
      actions.fetchNotifications(walletAddress);
    }
  }, [walletAddress, actions]);

  // Set up auto-refresh interval (check every 30 seconds)
  useEffect(() => {
    if (!walletAddress) return;

    const interval = setInterval(() => {
      actions.refreshNotifications(walletAddress);
    }, 30000);

    return () => clearInterval(interval);
  }, [walletAddress, actions]);

  const value: NotificationContextValue = {
    state,
    actions,
  };

  return (
    <NotificationContext.Provider value={value}>
      {children}
    </NotificationContext.Provider>
  );
}

/**
 * Hook to use notification state and actions
 * Must be used within NotificationProvider
 */
export function useNotifications() {
  const context = useContext(NotificationContext);
  if (!context) {
    throw new Error("useNotifications must be used within NotificationProvider");
  }
  return context;
}

/**
 * Hook to get only the unread count
 * Useful for header badge components
 */
export function useUnreadCount() {
  const { state } = useNotifications();
  return state.unreadCount;
}

/**
 * Hook to get only notifications
 */
export function useNotificationsList() {
  const { state, actions } = useNotifications();
  return {
    notifications: state.notifications,
    isLoading: state.isLoading,
    error: state.error,
    markAsRead: actions.markAsRead,
    markAllAsRead: actions.markAllAsRead,
  };
}

/**
 * Hook for digest view to refresh independently
 */
export function useNotificationDigest() {
  const { state, actions } = useNotifications();
  const { walletAddress } = useWallet();

  const refreshDigest = useCallback(async () => {
    if (walletAddress) {
      await actions.refreshNotifications(walletAddress);
    }
  }, [walletAddress, actions]);

  return {
    notifications: state.notifications,
    unreadCount: state.unreadCount,
    isLoading: state.isLoading,
    error: state.error,
    refresh: refreshDigest,
    markAsRead: actions.markAsRead,
    markAllAsRead: actions.markAllAsRead,
  };
}
