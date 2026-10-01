import { create } from 'zustand';
import { api, ApiError, onUnauthorized } from '../lib/http';
import type { User } from '../types';

const CACHED_USER_KEY = 'jr_user';

type Status = 'loading' | 'authenticated' | 'anonymous';

interface AuthState {
  user: User | null;
  status: Status;
  /** Signed in from the cached profile because the server could not be reached. */
  offlineSession: boolean;
  checkSession: () => Promise<void>;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  handleUnauthorized: () => void;
}

function readCachedUser(): User | null {
  try {
    const raw = localStorage.getItem(CACHED_USER_KEY);
    return raw ? (JSON.parse(raw) as User) : null;
  } catch {
    return null;
  }
}

function cacheUser(user: User | null) {
  try {
    if (user) localStorage.setItem(CACHED_USER_KEY, JSON.stringify(user));
    else localStorage.removeItem(CACHED_USER_KEY);
  } catch {
    // storage unavailable: offline sign-in just won't be possible
  }
}

export const useAuth = create<AuthState>((set, get) => ({
  user: null,
  status: 'loading',
  offlineSession: false,

  async checkSession() {
    try {
      const { user } = await api<{ user: User }>('/auth/me');
      cacheUser(user);
      set({ user, status: 'authenticated', offlineSession: false });
    } catch (err) {
      const cached = readCachedUser();
      if (err instanceof ApiError && err.offline && cached) {
        set({ user: cached, status: 'authenticated', offlineSession: true });
        return;
      }
      cacheUser(null);
      set({ user: null, status: 'anonymous', offlineSession: false });
    }
  },

  async login(username, password) {
    const { user } = await api<{ user: User }>('/auth/login', { method: 'POST', body: { username, password } });
    cacheUser(user);
    set({ user, status: 'authenticated', offlineSession: false });
  },

  async logout() {
    try {
      await api('/auth/logout', { method: 'POST' });
    } finally {
      cacheUser(null);
      set({ user: null, status: 'anonymous', offlineSession: false });
    }
  },

  handleUnauthorized() {
    if (get().status !== 'authenticated') return;
    cacheUser(null);
    set({ user: null, status: 'anonymous', offlineSession: false });
  },
}));

onUnauthorized(() => useAuth.getState().handleUnauthorized());

export function isStaff(user: User | null) {
  return user?.role === 'admin' || user?.role === 'coordinator';
}
