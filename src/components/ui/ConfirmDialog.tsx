import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Button } from './primitives';

interface ConfirmOptions {
  title: string;
  body?: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  tone?: 'danger' | 'warning' | 'primary';
}

/**
 * Promise-based confirmation dialog: `if (await confirm({...})) doIt()`.
 * Replaces window.confirm so the wording and consequences are readable, while still requiring an explicit click.
 */
export function useConfirm() {
  const [pending, setPending] = useState<(ConfirmOptions & { resolve: (ok: boolean) => void }) | null>(null);

  const confirm = useCallback((opts: ConfirmOptions) => new Promise<boolean>((resolve) => {
    setPending({ ...opts, resolve });
  }), []);

  const close = (ok: boolean) => {
    pending?.resolve(ok);
    setPending(null);
  };

  const dialog = pending ? <ConfirmDialog {...pending} onClose={close} /> : null;
  return { confirm, dialog };
}

function ConfirmDialog({ title, body, confirmLabel, cancelLabel = 'Cancel', tone = 'primary', onClose }: ConfirmOptions & { onClose: (ok: boolean) => void }) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-[3000] flex items-end sm:items-center justify-center bg-black/60 p-3" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(false); }}>
      <div role="alertdialog" aria-modal="true" aria-labelledby="jr-confirm-title" className="w-full max-w-md bg-bg-card border border-border-light rounded-xl shadow-2xl p-5 space-y-4">
        <div className="flex items-start gap-3">
          {tone !== 'primary' && (
            <span className={`flex-shrink-0 w-9 h-9 rounded-full flex items-center justify-center ${tone === 'danger' ? 'bg-danger/15 text-danger' : 'bg-warning/15 text-warning'}`}>
              <AlertTriangle className="w-5 h-5" />
            </span>
          )}
          <div className="min-w-0">
            <h2 id="jr-confirm-title" className="text-base font-semibold">{title}</h2>
            {body && <div className="text-sm text-text-muted mt-1.5 leading-relaxed">{body}</div>}
          </div>
        </div>
        <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
          <Button ref={cancelRef} variant="secondary" onClick={() => onClose(false)}>{cancelLabel}</Button>
          <Button variant={tone === 'danger' ? 'danger' : tone === 'warning' ? 'warning' : 'primary'} onClick={() => onClose(true)}>{confirmLabel}</Button>
        </div>
      </div>
    </div>
  );
}
