import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Shield } from 'lucide-react';

/** Frame for the no-login citizen pages: slim header, one centred mobile-first column. */
export function PublicShell({ context, children, footer }: { context: ReactNode; children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="min-h-dvh bg-bg flex flex-col">
      <header className="border-b border-border bg-bg-secondary">
        <div className="max-w-xl mx-auto px-4 h-14 flex items-center gap-2.5">
          <Link to="/public-report" className="flex items-center gap-2.5">
            <span className="w-8 h-8 rounded-lg bg-accent flex items-center justify-center"><Shield className="w-[18px] h-[18px] text-white" /></span>
            <span className="text-[15px] font-semibold">JanRakshak</span>
          </Link>
          <span className="ml-auto text-[10px] font-semibold uppercase tracking-[0.14em] text-accent">{context}</span>
        </div>
      </header>
      <main className="flex-1 w-full max-w-xl mx-auto px-4 py-5 space-y-4">{children}</main>
      {footer && <footer className="max-w-xl mx-auto w-full px-4 pb-6 text-center text-[11px] text-text-dim">{footer}</footer>}
    </div>
  );
}
