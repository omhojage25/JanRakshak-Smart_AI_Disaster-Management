import { ApiError } from './http';
import { postReport, type ReportPayload, type ReportResult } from './data';
import { useStore } from '../store/useStore';

const DB_NAME = 'janrakshak';
const STORE_NAME = 'pending_reports';
export const PENDING_CHANGED_EVENT = 'jr-pending-changed';

export interface PendingReport extends ReportPayload {
  queued_at: string;
  attempts: number;
  last_error: string | null;
  /** The server rejected it (e.g. invalid data); it will not be retried automatically. */
  failed: boolean;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE_NAME)) {
        req.result.createObjectStore(STORE_NAME, { keyPath: 'client_id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, mode);
    const req = fn(tx.objectStore(STORE_NAME));
    tx.oncomplete = () => {
      db.close();
      resolve(req.result);
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
    tx.onabort = () => {
      db.close();
      reject(tx.error ?? new Error('IndexedDB transaction aborted'));
    };
  });
}

export async function listPending(): Promise<PendingReport[]> {
  const all = await withStore<PendingReport[]>('readonly', (s) => s.getAll());
  return all.sort((a, b) => a.queued_at.localeCompare(b.queued_at));
}

async function savePending(item: PendingReport) {
  await withStore('readwrite', (s) => s.put(item));
}

export async function discardPending(clientId: string) {
  await withStore('readwrite', (s) => s.delete(clientId));
  await refreshPendingCount();
}

export async function refreshPendingCount() {
  try {
    const all = await listPending();
    useStore.getState().setPendingReports(all.filter((r) => !r.failed).length);
  } catch {
    useStore.getState().setPendingReports(0);
  }
  window.dispatchEvent(new Event(PENDING_CHANGED_EVENT));
}

async function enqueue(payload: ReportPayload) {
  await savePending({ ...payload, queued_at: new Date().toISOString(), attempts: 0, last_error: null, failed: false });
  await refreshPendingCount();
}

export type SubmitOutcome = { status: 'sent'; result: ReportResult } | { status: 'queued' };

/** Sends a report now, or stores it on the device if the server cannot be reached. */
export async function submitOrQueue(payload: ReportPayload): Promise<SubmitOutcome> {
  if (navigator.onLine === false) {
    await enqueue(payload);
    return { status: 'queued' };
  }
  try {
    return { status: 'sent', result: await postReport(payload) };
  } catch (err) {
    if (err instanceof ApiError && err.offline) {
      await enqueue(payload);
      return { status: 'queued' };
    }
    throw err;
  }
}

let flushing: Promise<number> | null = null;

/** Uploads queued reports in order. Stops at the first connectivity problem and tries again later. */
export function flushQueue(): Promise<number> {
  if (!flushing) {
    flushing = doFlush().finally(() => {
      flushing = null;
    });
  }
  return flushing;
}

async function doFlush(): Promise<number> {
  let items: PendingReport[];
  try {
    items = (await listPending()).filter((r) => !r.failed);
  } catch {
    return 0;
  }
  let sent = 0;
  for (const item of items) {
    const payload: ReportPayload = {
      raw_message: item.raw_message,
      source: item.source,
      reporter_name: item.reporter_name,
      reporter_phone: item.reporter_phone,
      client_id: item.client_id,
      reported_at: item.reported_at,
      reporter_lat: item.reporter_lat,
      reporter_lng: item.reporter_lng,
    };
    try {
      const result = await postReport(payload);
      await withStore('readwrite', (s) => s.delete(item.client_id));
      sent += 1;
      useStore.getState().pushToast({
        id: `sync-${item.client_id}`,
        type: 'success',
        title: 'Offline report delivered',
        message: result.incident?.title ?? item.raw_message.slice(0, 80),
        incident_id: result.incident?.id,
      });
    } catch (err) {
      const apiErr = err instanceof ApiError ? err : null;
      const transient = !apiErr || apiErr.offline || apiErr.status === 401 || apiErr.status === 429 || apiErr.status >= 500;
      await savePending({ ...item, attempts: item.attempts + 1, last_error: (err as Error).message, failed: !transient });
      if (transient) break;
    }
  }
  await refreshPendingCount();
  return sent;
}

export function startAutoSync(): () => void {
  const onOnline = () => void flushQueue();
  window.addEventListener('online', onOnline);
  const interval = window.setInterval(() => {
    if (useStore.getState().pendingReports > 0) void flushQueue();
  }, 20_000);
  void refreshPendingCount().then(() => flushQueue());
  return () => {
    window.removeEventListener('online', onOnline);
    window.clearInterval(interval);
  };
}
