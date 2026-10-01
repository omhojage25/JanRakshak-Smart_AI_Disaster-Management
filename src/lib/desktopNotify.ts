import type { AppNotification } from '../types';

const PREF_KEY = 'jr_desktop_notifications';

export function desktopNotificationsSupported() {
  return typeof window !== 'undefined' && 'Notification' in window;
}

export function desktopNotificationsEnabled() {
  if (!desktopNotificationsSupported() || Notification.permission !== 'granted') return false;
  try {
    return localStorage.getItem(PREF_KEY) !== 'off';
  } catch {
    return true;
  }
}

export async function enableDesktopNotifications(): Promise<NotificationPermission | 'unsupported'> {
  if (!desktopNotificationsSupported()) return 'unsupported';
  const permission = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
  try {
    localStorage.setItem(PREF_KEY, permission === 'granted' ? 'on' : 'off');
  } catch {
    // ignore
  }
  return permission;
}

export function disableDesktopNotifications() {
  try {
    localStorage.setItem(PREF_KEY, 'off');
  } catch {
    // ignore
  }
}

/** Shows an OS-level notification for important alerts, so they are seen even when the tab is in the background. */
export function showDesktopNotification(n: AppNotification, onClick?: () => void) {
  if (!desktopNotificationsEnabled()) return;
  if (n.type !== 'critical' && n.type !== 'warning') return;
  try {
    const shown = new Notification(n.title, { body: n.message, tag: n.id, requireInteraction: n.type === 'critical' });
    shown.onclick = () => {
      window.focus();
      onClick?.();
      shown.close();
    };
  } catch {
    // Some browsers only allow notifications from a service worker; the in-app toast still shows.
  }
}
