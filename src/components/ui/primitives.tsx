import { useState, type ComponentPropsWithRef, type ReactNode } from 'react';
import { AlertTriangle, ChevronDown, Info, Loader2, XCircle, CheckCircle2 } from 'lucide-react';
import { cx } from '../../utils/cx';
import { LOCATION_TONE_CLASS, PRIORITY_CONFIG, STATUS_CONFIG, type LocationQuality } from '../../utils/helpers';
import type { IncidentStatus, Priority } from '../../types';

/** Shared building blocks for every screen: one set of surfaces, badges and states. */

export function Panel({ children, className, as: Tag = 'section' }: { children: ReactNode; className?: string; as?: 'section' | 'div' | 'aside' }) {
  return <Tag className={cx('bg-bg-card border border-border rounded-xl', className)}>{children}</Tag>;
}

export function SectionHeader({ icon, title, meta, action, className }: {
  icon?: ReactNode; title: ReactNode; meta?: ReactNode; action?: ReactNode; className?: string;
}) {
  return (
    <div className={cx('flex items-center gap-2 min-w-0', className)}>
      {icon && <span className="text-text-dim flex-shrink-0 [&>svg]:w-4 [&>svg]:h-4">{icon}</span>}
      <h2 className="text-[11px] font-semibold uppercase tracking-wider text-text-muted truncate">{title}</h2>
      {meta && <span className="text-[11px] text-text-dim truncate">{meta}</span>}
      {action && <div className="ml-auto flex-shrink-0">{action}</div>}
    </div>
  );
}

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'success' | 'warning';
type ButtonSize = 'sm' | 'md' | 'lg';

const BUTTON_VARIANT: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-white hover:bg-accent-hover border border-accent',
  secondary: 'bg-bg-inset text-text border border-border-light hover:bg-bg-card-hover',
  ghost: 'text-text-muted hover:text-text hover:bg-bg-card-hover border border-transparent',
  danger: 'bg-danger/10 text-red-300 border border-danger/35 hover:bg-danger/20',
  success: 'bg-success text-white border border-success hover:brightness-110',
  warning: 'bg-warning/10 text-warning border border-warning/40 hover:bg-warning/20',
};
const BUTTON_SIZE: Record<ButtonSize, string> = {
  sm: 'text-xs px-2.5 py-1.5 gap-1.5 rounded-lg min-h-8',
  md: 'text-sm px-3.5 py-2 gap-2 rounded-lg min-h-10',
  lg: 'text-base px-5 py-3 gap-2 rounded-xl min-h-12 font-semibold',
};

export function Button({ variant = 'secondary', size = 'md', busy, icon, children, className, disabled, ...rest }: ComponentPropsWithRef<'button'> & {
  variant?: ButtonVariant; size?: ButtonSize; busy?: boolean; icon?: ReactNode;
}) {
  return (
    <button
      type="button"
      {...rest}
      disabled={disabled || busy}
      className={cx(
        'inline-flex items-center justify-center font-medium transition-colors cursor-pointer disabled:opacity-45 disabled:cursor-not-allowed select-none',
        BUTTON_VARIANT[variant], BUTTON_SIZE[size], className,
      )}
    >
      {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : icon}
      {children}
    </button>
  );
}

export function Badge({ children, className, title }: { children: ReactNode; className?: string; title?: string }) {
  return (
    <span title={title} className={cx('inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold border whitespace-nowrap', className)}>
      {children}
    </span>
  );
}

/** Severity is always shown as a word plus colour, never colour alone. */
export function SeverityBadge({ priority, score, size = 'sm' }: { priority: Priority; score?: number; size?: 'sm' | 'md' }) {
  const cfg = PRIORITY_CONFIG[priority];
  return (
    <span
      className={cx('inline-flex items-center gap-1 rounded font-bold uppercase tracking-wide whitespace-nowrap border',
        size === 'md' ? 'text-xs px-2 py-1' : 'text-[10px] px-1.5 py-0.5')}
      style={{ color: cfg.color, background: cfg.bg, borderColor: `${cfg.color}55` }}
    >
      {cfg.label}{score != null && <span className="font-medium opacity-80">· {score}</span>}
    </span>
  );
}

export function StatusBadge({ status }: { status: IncidentStatus }) {
  const cfg = STATUS_CONFIG[status];
  return (
    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium border whitespace-nowrap" style={{ color: cfg.color, borderColor: `${cfg.color}55` }} title={cfg.description}>
      <span className="w-1.5 h-1.5 rounded-full" style={{ background: cfg.color }} />
      {cfg.label}
    </span>
  );
}

export function LocationBadge({ quality, compact }: { quality: LocationQuality; compact?: boolean }) {
  return (
    <Badge className={LOCATION_TONE_CLASS[quality.tone]} title={quality.explanation}>
      {quality.needsVerification && <AlertTriangle className="w-3 h-3" />}
      {compact && quality.needsVerification ? 'Verify location' : quality.label}
    </Badge>
  );
}

export function Stat({ label, value, tone, hint }: { label: string; value: ReactNode; tone?: string; hint?: string }) {
  return (
    <div className="min-w-0" title={hint}>
      <div className={cx('text-xl font-semibold leading-none tabular-nums', tone ?? 'text-text')}>{value}</div>
      <div className="text-[11px] text-text-dim mt-1 truncate">{label}</div>
    </div>
  );
}

export function EmptyState({ icon, title, children, className }: { icon?: ReactNode; title: string; children?: ReactNode; className?: string }) {
  return (
    <div className={cx('flex flex-col items-center text-center gap-1.5 py-6 px-4 text-text-dim', className)}>
      {icon && <span className="[&>svg]:w-5 [&>svg]:h-5 text-text-dim/80">{icon}</span>}
      <p className="text-sm text-text-muted">{title}</p>
      {children && <div className="text-xs max-w-xs">{children}</div>}
    </div>
  );
}

type CalloutTone = 'info' | 'warning' | 'danger' | 'success';
const CALLOUT: Record<CalloutTone, { cls: string; icon: ReactNode }> = {
  info: { cls: 'border-accent/30 bg-accent/10 text-blue-200', icon: <Info className="w-4 h-4" /> },
  warning: { cls: 'border-warning/35 bg-warning/10 text-yellow-200', icon: <AlertTriangle className="w-4 h-4" /> },
  danger: { cls: 'border-danger/35 bg-danger/10 text-red-200', icon: <XCircle className="w-4 h-4" /> },
  success: { cls: 'border-success/35 bg-success/10 text-green-200', icon: <CheckCircle2 className="w-4 h-4" /> },
};

export function Callout({ tone = 'info', title, children, action, className, icon }: {
  tone?: CalloutTone; title?: ReactNode; children?: ReactNode; action?: ReactNode; className?: string; icon?: ReactNode;
}) {
  const c = CALLOUT[tone];
  return (
    <div role={tone === 'danger' ? 'alert' : undefined} className={cx('flex items-start gap-2.5 p-3 rounded-lg border text-xs', c.cls, className)}>
      <span className="flex-shrink-0 mt-px">{icon ?? c.icon}</span>
      <div className="flex-1 min-w-0 space-y-1">
        {title && <div className="font-semibold text-[13px] leading-snug">{title}</div>}
        {children && <div className="text-text-muted leading-relaxed">{children}</div>}
        {action && <div className="pt-1.5">{action}</div>}
      </div>
    </div>
  );
}

/** A section that can be collapsed; used for progressive disclosure in the incident panel. */
export function Collapsible({ title, icon, meta, defaultOpen = true, children, id }: {
  title: string; icon?: ReactNode; meta?: ReactNode; defaultOpen?: boolean; children: ReactNode; id?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="border-t border-border first:border-t-0" id={id}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="w-full flex items-center gap-2 px-4 py-3 text-left cursor-pointer hover:bg-bg-card-hover/50"
      >
        {icon && <span className="text-text-dim [&>svg]:w-4 [&>svg]:h-4">{icon}</span>}
        <span className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">{title}</span>
        {meta && <span className="text-[11px] text-text-dim truncate">{meta}</span>}
        <ChevronDown className={cx('w-4 h-4 text-text-dim ml-auto transition-transform', open && 'rotate-180')} />
      </button>
      {open && <div className="px-4 pb-4">{children}</div>}
    </section>
  );
}

export function Segmented<T extends string>({ value, onChange, options, className, label }: {
  value: T; onChange: (v: T) => void; options: { value: T; label: ReactNode }[]; className?: string; label: string;
}) {
  return (
    <div role="tablist" aria-label={label} className={cx('flex gap-0.5 p-0.5 rounded-lg bg-bg-inset border border-border', className)}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          aria-selected={value === o.value}
          onClick={() => onChange(o.value)}
          className={cx(
            'flex-1 px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors cursor-pointer whitespace-nowrap',
            value === o.value ? 'bg-bg-card-hover text-text shadow-sm' : 'text-text-dim hover:text-text',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cx('w-5 h-5 animate-spin text-accent', className)} aria-label="Loading" />;
}

export function LoadingBlock({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-6 text-xs text-text-dim">
      <Spinner className="w-4 h-4" /> {label}
    </div>
  );
}
