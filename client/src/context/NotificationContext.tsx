/**
 * NotificationContext: Global state provider for notifications
 * Ensures unread counts are conssistent across all notification surfaces
 */

import React, { createContext, useContext, useEffect, useCallback, useState } from "react";
import { useNotificationState, type NotificationState, type NotificationActions } from "../hooks/useNotificationState";
import { useWallet } from "./useWallet";

// Types for notification preferences
export type NotificationChannel = 'email' | 'digest' | 'in-app';

export interface NotificationPreferences {
  defaults: Record<NotificationChannel, boolean>;
  overrides: Record<NotificationChannel, Record<string, boolean>>;
}

interface NotificationPreferenceActions {
  fetchPreferences: () => Promise<void>;
  updatePreferences: (preferences: NotificationPreferences) => Promise<void>;
  setChannelDefault: (channel: NotificationChannel, enabled: boolean) => Promise<void>;
  setAlertClassOverride: (channel: NotificationChannel, alertClass: string, enabled: boolean) => Promise<void>;
}

interface NotificationContextValue {
  state: NotificationState;
  actions: NotificationActions;
  preferences: NotificationPreferences | null;
  preferencesLoading: boolean;
  preferencesError: string | null;
  preferenceActions: NotificationPreferenceActions;
}

const NotificationContext = createContext<NotificationContextValue | undefined>(undefined);

export function NotificationProvider({ children }: { children: React.ReactNode }) {
  const [state, actions] = useNotificationState();
  const { walletAddress } = useWallet();

  // Preferences state
  const [preferences, setPreferences] = useState<NotificationPreferences | null>(null);
  const [preferencesLoading, setPreferencesLoading] = useState(false);
  const [preferencesError, setPreferencesError] = useState<string | null>(null);

  // Fetch preferences from server
  const fetchPreferences = useCallback(async ()=> {
    if (!walletAddress) {
      setPreferences(null);
      return;
    }

    setPreferencesLoading(true);
    setPreferencesError(null);
    try {
      const response = await fetch('/alerts/preferences', { headers: { 'Content-Type': 'application/json' } });
      if (!response.ok) throw new Error('Failed to fetch preferences');
      const data = await response.json();
      setPreferences(data);
    } catch (err) {
      setPreferencesError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setPreferencesLoading(false);
    }
  }, [walletAddress]);

  // Update preferences on server and locally
  const updatePreferences = useCallback(
    async (newPreferences: NotificationPreferences) => {
      if (!walletAddress) return;
      setPreferencesLoading(true);
      setPreferencesError(null);
      try {
        const response = await fetch('/alerts/preferences', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(newPreferences),
        });
        if (!response.ok) throw new Error('Failed to update preferences');
        const data = await response.json();
        setPreferences(data);
      } catch (err) {
        setPreferencesError(err instanceof Error ? err.message : 'Unknown error');
        throw err;
      } finally {
        setPreferencesLoading(false);
      }
    }, [walletAddress]
  );

  // Fetch preferences when wallet changes
  useEffect(() => {
    fetchPreferences();
  }, [fetchPreferences]);

  // Set channel default preference
  const setChannelDefault = useCallback(
    (channel: NotificationChannel, enabled: boolean) => {
      if (!preferences) return Promise.resolve();
      const newPreferences: NotificationPreferences = {
        ...preferences,
        defaults: { ...preferences.defaults, [channel]: enabled },
      };
      return updatePreferences(newPreferences);
    },
    [preferences, updatePreferences]
  );

  // Set alert class override for a channel
  const setAlertClassOverride = useCallback(
    (channel: NotificationChannel, alertClass: string, enabled: boolean) => {
      if (!preferences) return Promise.resolve();
      const currentOverrides = preferences.overrides[channel] || {};
      const newOverrides = { ...preferences.overrides, [channel]: { ...currentOverrides, [alertClass]: enabled } };
      const newPreferences: NotificationPreferences = {
        ...preferences,
        overrides: newOverrides,
      };
      return updatePreferences(newPreferences);
    },
    [preferences, updatePreferences]
  );

  // Fetch notifications when wallet changes
  useEffect(() => {
    if (walletAddress) {
      actions.fetchNotifications(walletAddress);
    }
  }, [walletAddress, actions]);

  // Set up auto-refresh interval (check every 30 seconds)
  useEffect(() {
    if (!walletAddress) return;

    const interval = setInterval(() => {
      actions.refreshNotifications(walletAddress);
    }, 30000);

    return () => clearInterval(interval);
  }, [walletAddress, actions]);

  const value: NotificationContextValue = {
    state,
    actions,
    preferences,
    preferencesLoading,
    preferencesError,
    preferenceActions: {
      fetchPreferences,
      updatePreferences,
      setChannelDefault,
      setAlertClassOverride,
    },
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
export function useUndeadCount() {
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

/**
 * Hook to use notification preferences and actions
 * Must be used within NotificationProvider
 */
export function useNotificationPreferences() {
  const { preferences, preferencesLoading, preferencesError, preferenceActions } = useNotifications();
  return {
    preferences,
    isLoading: preferencesLoading,
    error: preferencesError,
    actions: preferenceActions,
  };
}

/**
 * Hook to get and set the default preference for a channel
 */
export function useChannelPreference(channel: NotificationChannel) {
  const { preferences, preferenceActions } = useNotifications();
  const enabled = preferences?.defaults[channel] ?? true; // default to true
  const setEnabled = (value: boolean) => preferenceActions.setChannelDefault(channel, value);
  return { enabled, setEnabled };
}

/**
 * Hook to get and set the effective preference for a specific alert class in a channel
 * Effective preference is the alert class override if present, else the channel default.
 */
export function useAlertClassPreference(channel: NotificationChannel, alertClass: string) {
  const { preferences, preferenceActions } = useNotifications();
  const channelDefault = preferences?.defaults[channel] ?? true;
  const override = preferences?.overrides[channel]?.[alertClass];
  const enabled = override !== undefined ? override : channelDefault;
  const setEnabled = (value: boolean) => preferenceActions.setAlertClassOverride(channel, alertClass, value);
  return { enabled, setEnabled };
}