export class ApiError extends Error {
  status: number;
  code?: string;
  /** True when the server could not be reached at all (no network, server down, gateway error). */
  offline: boolean;

  constructor(message: string, status: number, offline = false, code?: string) {
    super(message);
    this.status = status;
    this.offline = offline;
    this.code = code;
  }
}

let unauthorizedHandler: (() => void) | null = null;

export function onUnauthorized(handler: () => void) {
  unauthorizedHandler = handler;
}

export async function api<T>(path: string, options: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method: options.method ?? 'GET',
      headers: options.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      credentials: 'same-origin',
      signal: options.signal,
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new ApiError('Cannot reach the server', 0, true);
  }

  if (res.status === 401 && !path.startsWith('/auth/')) unauthorizedHandler?.();

  if (!res.ok) {
    const data = await res.json().catch(() => null) as { error?: string; code?: string } | null;
    const gatewayDown = res.status === 502 || res.status === 503 || res.status === 504;
    throw new ApiError(data?.error ?? res.statusText ?? 'Request failed', res.status, gatewayDown, data?.code);
  }
  return res.json() as Promise<T>;
}

/** UUID v4 that also works on plain-http pages, where crypto.randomUUID is unavailable. */
export function uuid(): string {
  if (typeof crypto.randomUUID === 'function' && window.isSecureContext) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
