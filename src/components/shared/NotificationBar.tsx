import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bell, AlertTriangle, Info, CheckCircle, AlertCircle, MonitorSmartphone } from 'lucide-react';
import { useStore } from '../../store/useStore';
import { useAuth } from '../../store/useAuth';
import { formatTimeAgo } from '../../utils/helpers';
import { markAllNotificationsRead, markNotificationRead } from '../../lib/data';
import {
  desktopNotificationsEnabled, desktopNotificationsSupported, disableDesktopNotifications, enableDesktopNotifications,
} from '../../lib/desktopNotify';
import type { AppNotification } from '../../types';

const TYPE_CONFIG = {
  critical: { icon: AlertTriangle, color: '#ef4444' },
  warning: { icon: AlertCircle, color: '#eab308' },
  info: { icon: Info, color: '#3b82f6' },
  success: { icon: CheckCircle, color: '#22c55e' },
};

export function NotificationBar() {
  const notifications = useStore((s) => s.notifications);
  const role = useAuth((s) => s.user?.role);
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [desktopOn, setDesktopOn] = useState(desktopNotificationsEnabled());
  const [permissionNote, setPermissionNote] = useState<string | null>(null);

  const unread = notifications.filter((n) => !n.read);
  const hasCriticalUnread = unread.some((n) => n.type === 'critical');

  const openNotification = (n: AppNotification) => {
    if (!n.read) markNotificationRead(n.id).catch(() => {});
    if (n.incident_id && role !== 'field_reporter') {
      const incident = useStore.getState().incidents.find((i) => i.id === n.incident_id);
      useStore.getState().selectAndFlyTo(n.incident_id, incident?.location_lat, incident?.location_lng);
      navigate('/');
      setOpen(false);
    }
  };

  const toggleDesktop = async () => {
    if (desktopOn) {
      disableDesktopNotifications();
      setDesktopOn(false);
      return;
    }
    const result = await enableDesktopNotifications();
    setDesktopOn(result === 'granted');
    setPermissionNote(result === 'denied' ? 'Blocked by the browser. Allow notifications in site settings.' : result === 'unsupported' ? 'Not supported in this browser.' : null);
  };

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="relative p-2 rounded-lg hover:bg-bg-card-hover transition-colors cursor-pointer"
        aria-label={`Notifications (${unread.length} unread)`}
      >
        <Bell className="w-5 h-5 text-text-muted" />
        {unread.length > 0 && (
          <span className={`absolute -top-0.5 -right-0.5 min-w-4 h-4 px-1 rounded-full text-[10px] font-bold flex items-center justify-center text-white ${
            hasCriticalUnread ? 'bg-danger animate-pulse' : 'bg-accent'
          }`}>
            {unread.length > 9 ? '9+' : unread.length}
          </span>
        )}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="fixed sm:absolute left-2 right-2 sm:left-auto sm:right-0 top-14 sm:top-full sm:mt-2 sm:w-96 bg-bg-card border border-border rounded-xl shadow-2xl z-50 overflow-hidden">
            <div className="px-3 py-2 border-b border-border flex items-center justify-between gap-2">
              <span className="text-xs font-semibold">Notifications</span>
              {unread.length > 0 && (
                <button onClick={() => markAllNotificationsRead().catch(() => {})} className="text-[10px] text-accent hover:underline cursor-pointer">
                  Mark all read
                </button>
              )}
            </div>
            {desktopNotificationsSupported() && (
              <div className="px-3 py-2 border-b border-border bg-bg/50">
                <label className="flex items-center justify-between gap-2 text-[11px] text-text-muted cursor-pointer">
                  <span className="flex items-center gap-1.5">
                    <MonitorSmartphone className="w-3.5 h-3.5" />
                    Desktop alerts for critical & warning events
                  </span>
                  <input type="checkbox" checked={desktopOn} onChange={toggleDesktop} className="accent-accent cursor-pointer" />
                </label>
                {permissionNote && <div className="text-[10px] text-danger mt-1">{permissionNote}</div>}
              </div>
            )}
            <div className="max-h-[60vh] sm:max-h-80 overflow-y-auto">
              {notifications.length === 0 && (
                <div className="p-4 text-center text-xs text-text-dim">No notifications</div>
              )}
              {notifications.map((n) => {
                const cfg = TYPE_CONFIG[n.type];
                const Icon = cfg.icon;
                return (
                  <button
                    key={n.id}
                    onClick={() => openNotification(n)}
                    className={`w-full text-left px-3 py-2 border-b border-border last:border-0 hover:bg-bg-card-hover transition-colors cursor-pointer ${n.read ? 'opacity-60' : ''}`}
                  >
                    <div className="flex items-start gap-2">
                      <Icon className="w-4 h-4 flex-shrink-0 mt-0.5" style={{ color: cfg.color }} />
                      <div className="flex-1 min-w-0">
                        <div className="text-xs font-medium flex items-center gap-1">
                          {!n.read && <span className="w-1.5 h-1.5 rounded-full bg-accent flex-shrink-0" />}
                          <span className="truncate">{n.title}</span>
                        </div>
                        <div className="text-[11px] text-text-muted line-clamp-2">{n.message}</div>
                        <div className="text-[10px] text-text-dim mt-0.5">{formatTimeAgo(n.created_at)}</div>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
