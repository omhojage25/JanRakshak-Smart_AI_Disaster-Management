import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import {
  Activity, AlertTriangle, ArrowLeft, Brain, ClipboardCheck, Clock, FileText, Flag, MapPin, RotateCcw, Truck, Users, X, Zap,
  ListChecks, HeartPulse, Copy,
} from 'lucide-react';
import { useStore, isActiveStatus } from '../../store/useStore';
import { useAuth } from '../../store/useAuth';
import { fetchIncidentDemand, fetchIncidentDetail, fetchTimeline, transitionIncident } from '../../lib/data';
import { ACTIVE_ASSIGNMENT } from '../../lib/operations';
import {
  INCIDENT_TYPE_CONFIG, STATUS_CONFIG, WORKFLOW_ORDER, formatTimeAgo, getEscalationTimeLeft, locationQuality, shortId,
} from '../../utils/helpers';
import { Button, Callout, Collapsible, LocationBadge, SeverityBadge, StatusBadge } from '../ui/primitives';
import { cx } from '../../utils/cx';
import { useConfirm } from '../ui/ConfirmDialog';
import { RiskAssessmentPanel } from './RiskAssessmentPanel';
import { LocationSection } from '../incident/LocationSection';
import { DuplicateReview } from '../incident/DuplicateReview';
import { RequiredResponse } from '../incident/RequiredResponse';
import { matchSlots } from '../../lib/slots';
import { UnitsSection } from '../incident/UnitsSection';
import type { AuditEntry, Incident, IncidentDemand, IncidentDetailData, IncidentStatus, RecommendResult } from '../../types';

const TRANSITIONS: Record<IncidentStatus, IncidentStatus[]> = {
  triage: ['dispatched', 'resolved'],
  dispatched: ['on_scene', 'resolved'],
  on_scene: ['contained', 'resolved'],
  contained: ['on_scene', 'resolved'],
  resolved: ['closed', 'triage'],
  closed: [],
};

function actionLabel(from: IncidentStatus, to: IncidentStatus) {
  if (to === 'triage') return 'Reopen';
  if (to === 'on_scene' && from === 'contained') return 'Back to on scene';
  if (to === 'closed') return 'Close with review…';
  if (to === 'resolved') return 'Resolve';
  return `Mark ${STATUS_CONFIG[to].label.toLowerCase()}`;
}

/**
 * Decision-support view for one incident, ordered as a coordinator reads it:
 * identity → attention items → risk → location → status → requirements → units → evidence → activity.
 */
export function IncidentDetail({ incidentId }: { incidentId: string }) {
  const incidents = useStore((s) => s.incidents);
  const allAssignments = useStore((s) => s.assignments);
  const resources = useStore((s) => s.resources);
  const selectIncident = useStore((s) => s.selectIncident);
  const canManage = useAuth((s) => s.user?.role !== 'field_reporter');
  const incident = useMemo(() => incidents.find((i) => i.id === incidentId), [incidents, incidentId]);
  const assignments = useMemo(() => allAssignments.filter((a) => a.incident_id === incidentId), [allAssignments, incidentId]);
  const resourcesById = useMemo(() => new Map(resources.map((r) => [r.id, r])), [resources]);
  const [detail, setDetail] = useState<IncidentDetailData | null>(null);
  const [demand, setDemand] = useState<IncidentDemand | null>(null);
  const [demandError, setDemandError] = useState('');
  const [outcomes, setOutcomes] = useState<RecommendResult['slots'] | null>(null);

  // Server-computed extras (reports, impact, review) and the demand model follow incident and assignment changes.
  const changeKey = `${incident?.updated_at}|${assignments.map((a) => `${a.id}:${a.status}`).join(',')}`;
  useEffect(() => {
    const ctrl = new AbortController();
    fetchIncidentDetail(incidentId, ctrl.signal).then(setDetail).catch(() => {});
    return () => ctrl.abort();
  }, [incidentId, changeKey]);

  const demandKey = `${incident?.updated_at}|${incident?.priority}`;
  useEffect(() => {
    const ctrl = new AbortController();
    fetchIncidentDemand(incidentId, ctrl.signal)
      .then((d) => { setDemand(d); setDemandError(''); })
      .catch((err) => { if ((err as Error).name !== 'AbortError') setDemandError((err as Error).message); });
    return () => ctrl.abort();
  }, [incidentId, demandKey]);

  const matched = useMemo(
    () => (demand ? matchSlots(demand, assignments, resourcesById, outcomes) : { statuses: [], extra: [] }),
    [demand, assignments, resourcesById, outcomes],
  );

  if (!incident) {
    return (
      <div className="p-4 text-sm text-text-muted flex items-center justify-between gap-2">
        This incident is no longer in the current view.
        <Button size="sm" variant="ghost" onClick={() => selectIncident(null)}>Back to overview</Button>
      </div>
    );
  }

  const cfg = INCIDENT_TYPE_CONFIG[incident.type];
  const active = isActiveStatus(incident.status);
  const q = locationQuality(incident);
  const esc = active ? getEscalationTimeLeft(incident.escalation_deadline) : null;
  const proposals = assignments.filter((a) => a.status === 'recommended');
  const responding = assignments.filter((a) => ACTIVE_ASSIGNMENT.includes(a.status));
  const covered = matched.statuses.filter((s) => s.state === 'covered').length;

  return (
    <div className="flex flex-col min-h-0 h-full">
      <header className="px-4 pt-3 pb-3 border-b border-border space-y-2">
        <div className="flex items-center gap-2">
          <Button size="sm" variant="ghost" className="-ml-2" icon={<ArrowLeft className="w-3.5 h-3.5" />} onClick={() => selectIncident(null)}>Overview</Button>
          <span className="text-[11px] font-mono text-text-dim">#{shortId(incident.id)}</span>
          <div className="ml-auto flex items-center gap-1.5">
            <SeverityBadge priority={incident.priority} score={incident.priority_score} size="md" />
            <button type="button" onClick={() => selectIncident(null)} className="p-1.5 rounded-md hover:bg-bg-card-hover cursor-pointer" aria-label="Close incident">
              <X className="w-4 h-4 text-text-dim" />
            </button>
          </div>
        </div>
        <div className="flex items-start gap-2.5">
          <span className="text-2xl leading-none mt-0.5" aria-hidden>{cfg.icon}</span>
          <div className="min-w-0">
            <h2 className="text-base font-semibold leading-snug">{incident.title}</h2>
            <div className="text-xs text-text-muted flex items-center gap-1 mt-0.5 min-w-0">
              <MapPin className="w-3.5 h-3.5 flex-shrink-0 text-text-dim" />
              <span className="truncate">{incident.location_name ?? 'Unknown location'}</span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          <StatusBadge status={incident.status} />
          {(q.needsVerification || q.tone === 'warn') && <LocationBadge quality={q} compact />}
          <span className="text-[11px] text-text-dim">{cfg.label}</span>
        </div>
        <div className="grid grid-cols-4 gap-2 pt-1">
          <Mini icon={<Clock />} label="Reported" value={formatTimeAgo(incident.created_at)} />
          <Mini icon={<Users />} label="Affected" value={String(incident.people_affected)} />
          <Mini icon={<HeartPulse />} label="Injured" value={String(incident.injuries)} />
          <Mini icon={<Copy />} label="Reports" value={String(incident.corroborating_reports)} />
        </div>
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {(incident.dedup_review?.status === 'pending' || (esc && esc.minutes === 0) || (active && proposals.length > 0)) && (
          <div className="p-3 space-y-2 border-b border-border">
            {esc && esc.minutes === 0 && (
              <Callout tone="danger" title={incident.status === 'triage' ? 'Dispatch deadline passed' : 'Arrival deadline passed'}>
                This incident has been escalated. Review the response below.
              </Callout>
            )}
            <DuplicateReview incident={incident} canManage={canManage} />
            {active && proposals.length > 0 && (
              <Callout tone="info" title="Coordinator approval required" icon={<ListChecks className="w-4 h-4" />}>
                {proposals.length} unit proposal{proposals.length > 1 ? 's are' : ' is'} waiting in Units & recommendations below. Nothing is dispatched until you approve.
              </Callout>
            )}
          </div>
        )}

        <Collapsible title="AI risk assessment" icon={<Brain />} meta={incident.risk_assessment?.status === 'ok' ? `${incident.risk_assessment.model_class} · ${incident.risk_assessment.model_score}/100` : undefined}>
          <RiskAssessmentPanel incident={incident} />
        </Collapsible>

        <Collapsible title="Location" icon={<MapPin />} meta={q.label} defaultOpen={q.needsVerification}>
          <LocationSection incident={incident} canManage={canManage} active={active} />
        </Collapsible>

        <Collapsible title="Status" icon={<Flag />} meta={STATUS_CONFIG[incident.status].label} defaultOpen={active}>
          <WorkflowControls incident={incident} hasActiveAssignment={responding.length > 0} />
        </Collapsible>

        <Collapsible title="Required response" icon={<ListChecks />} meta={demand ? `${covered}/${matched.statuses.length} covered` : undefined} defaultOpen={active}>
          <RequiredResponse demand={demand} error={demandError} statuses={matched.statuses} extra={matched.extra} resourcesById={resourcesById} />
        </Collapsible>

        <Collapsible
          id="jr-units"
          title="Units & recommendations"
          icon={<Truck />}
          meta={[responding.length ? `${responding.length} responding` : null, proposals.length ? `${proposals.length} proposed` : null].filter(Boolean).join(' · ') || undefined}
        >
          <UnitsSection
            incident={incident}
            assignments={assignments}
            resourcesById={resourcesById}
            slotStatuses={matched.statuses}
            canManage={canManage}
            active={active}
            onRecommendResult={(r) => setOutcomes(r.slots)}
          />
        </Collapsible>

        <Collapsible title="Evidence & reports" icon={<FileText />} meta={detail ? `${detail.reports.length} report${detail.reports.length === 1 ? '' : 's'}` : undefined} defaultOpen={false}>
          <EvidenceSection incident={incident} detail={detail} />
        </Collapsible>

        <Collapsible title="Activity log" icon={<Activity />} defaultOpen={false}>
          <Timeline incidentId={incidentId} changeKey={changeKey} />
        </Collapsible>
      </div>
    </div>
  );
}

function Mini({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-md bg-bg-inset border border-border px-2 py-1.5">
      <div className="flex items-center gap-1 text-[10px] text-text-dim [&>svg]:w-3 [&>svg]:h-3">{icon}{label}</div>
      <div className="text-xs font-semibold truncate tabular-nums mt-0.5">{value}</div>
    </div>
  );
}

function WorkflowControls({ incident, hasActiveAssignment }: { incident: Incident; hasActiveAssignment: boolean }) {
  const canManage = useAuth((s) => s.user?.role !== 'field_reporter');
  const [busy, setBusy] = useState<IncidentStatus | null>(null);
  const [error, setError] = useState('');
  const [closing, setClosing] = useState(false);
  const { confirm, dialog } = useConfirm();
  const currentIdx = WORKFLOW_ORDER.indexOf(incident.status);
  const options = TRANSITIONS[incident.status].filter((to) => to !== 'dispatched' || hasActiveAssignment);

  const go = async (to: IncidentStatus) => {
    if (to === 'closed') {
      setClosing(true);
      return;
    }
    if (to === 'resolved' && !(await confirm({
      title: 'Resolve this incident?',
      body: 'All assigned units will be released and citizens tracking it will see it as resolved.',
      confirmLabel: 'Resolve incident',
      tone: 'warning',
    }))) return;
    setBusy(to);
    setError('');
    try {
      await transitionIncident(incident.id, to);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-3">
      <ol className="flex items-center gap-1 overflow-x-auto pb-1" aria-label="Incident workflow">
        {WORKFLOW_ORDER.map((s, idx) => {
          const done = idx < currentIdx;
          const current = idx === currentIdx;
          return (
            <li key={s} className="flex items-center gap-1 flex-shrink-0" aria-current={current ? 'step' : undefined}>
              <span
                className={cx('px-2 py-1 rounded-md text-[10px] font-medium border whitespace-nowrap',
                  current ? 'text-text bg-bg-card-hover border-border-light' : done ? 'text-text-muted border-border' : 'text-text-dim border-transparent')}
                title={STATUS_CONFIG[s].description}
              >
                {done && '✓ '}{STATUS_CONFIG[s].label}
              </span>
              {idx < WORKFLOW_ORDER.length - 1 && <span className="w-2 h-px bg-border" />}
            </li>
          );
        })}
      </ol>

      {canManage && options.length > 0 && (
        <div className="flex gap-2 flex-wrap">
          {options.map((to) => (
            <Button
              key={to}
              size="sm"
              className="flex-1 min-w-[8rem]"
              variant={to === 'resolved' ? 'secondary' : to === 'triage' ? 'ghost' : 'primary'}
              busy={busy === to}
              disabled={busy !== null && busy !== to}
              icon={to === 'closed' ? <ClipboardCheck className="w-3.5 h-3.5" /> : to === 'triage' ? <RotateCcw className="w-3.5 h-3.5" /> : <Flag className="w-3.5 h-3.5" />}
              onClick={() => go(to)}
            >
              {actionLabel(incident.status, to)}
            </Button>
          ))}
        </div>
      )}
      {incident.status === 'triage' && !hasActiveAssignment && (
        <p className="text-[11px] text-text-dim">The incident moves to Dispatched when you approve a unit under Units & recommendations.</p>
      )}
      {error && <p className="text-xs text-red-300">{error}</p>}
      {closing && <CloseReviewForm incidentId={incident.id} onDone={() => setClosing(false)} />}
      {dialog}
    </div>
  );
}

function CloseReviewForm({ incidentId, onDone }: { incidentId: string; onDone: () => void }) {
  const [summary, setSummary] = useState('');
  const [wentWell, setWentWell] = useState('');
  const [improvements, setImprovements] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await transitionIncident(incidentId, 'closed', {
        review: { summary: summary.trim(), went_well: wentWell.trim() || undefined, improvements: improvements.trim() || undefined },
      });
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const area = 'w-full bg-bg-inset border border-border rounded-lg px-3 py-2 text-sm sm:text-xs focus:outline-none focus:border-accent resize-y';
  return (
    <form onSubmit={submit} className="p-3 rounded-lg border border-border bg-bg-inset space-y-2">
      <div className="text-xs font-semibold">Post-incident review</div>
      <textarea className={area} rows={2} placeholder="Summary of the response (required)" value={summary} onChange={(e) => setSummary(e.target.value)} required maxLength={5000} />
      <textarea className={area} rows={2} placeholder="What went well" value={wentWell} onChange={(e) => setWentWell(e.target.value)} maxLength={5000} />
      <textarea className={area} rows={2} placeholder="What should improve next time" value={improvements} onChange={(e) => setImprovements(e.target.value)} maxLength={5000} />
      {error && <p className="text-xs text-red-300">{error}</p>}
      <div className="flex gap-2">
        <Button type="submit" variant="primary" size="sm" className="flex-1" busy={busy} disabled={!summary.trim()}>Close incident</Button>
        <Button size="sm" onClick={onDone}>Cancel</Button>
      </div>
    </form>
  );
}

function EvidenceSection({ incident, detail }: { incident: Incident; detail: IncidentDetailData | null }) {
  const impact = detail?.impact.filter((a) => a.severity === 'critical' || a.severity === 'high').slice(0, 4) ?? [];
  const vulnerable = [incident.has_children && 'Children', incident.has_elderly && 'Elderly', incident.has_disabled && 'Disabled'].filter(Boolean) as string[];
  return (
    <div className="space-y-3">
      {incident.description && <p className="text-sm text-text-muted leading-relaxed">{incident.description}</p>}
      {vulnerable.length > 0 && (
        <div className="flex gap-1 flex-wrap items-center">
          <span className="text-[11px] text-text-dim mr-1">Vulnerable people:</span>
          {vulnerable.map((v) => <span key={v} className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-danger/10 text-red-300 border border-danger/25">{v}</span>)}
        </div>
      )}
      {incident.urgency_indicators?.length > 0 && (
        <div className="flex gap-1 flex-wrap items-center">
          <span className="text-[11px] text-text-dim mr-1">Urgency:</span>
          {incident.urgency_indicators.map((u) => <span key={u} className="px-1.5 py-0.5 text-[10px] bg-warning/10 text-warning rounded border border-warning/25">{u}</span>)}
        </div>
      )}

      {impact.length > 0 && (
        <div>
          <div className="text-[11px] text-text-dim mb-1 flex items-center gap-1"><Zap className="w-3 h-3 text-warning" /> Impact on nearby incidents & resources</div>
          <ul className="space-y-1">
            {impact.map((a) => (
              <li key={`${a.affected_entity_id}-${a.type}`} className="text-[11px] text-text-muted flex gap-1.5">
                <AlertTriangle className={cx('w-3 h-3 mt-0.5 flex-shrink-0', a.severity === 'critical' ? 'text-danger' : 'text-warning')} />
                {a.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      {detail?.review && (
        <div className="p-3 rounded-lg border border-border bg-bg-inset text-xs space-y-1">
          <div className="font-semibold flex items-center gap-1"><ClipboardCheck className="w-3.5 h-3.5" /> Post-incident review</div>
          <p className="text-text-muted">{detail.review.summary}</p>
          {detail.review.went_well && <p><span className="text-success">Went well:</span> <span className="text-text-muted">{detail.review.went_well}</span></p>}
          {detail.review.improvements && <p><span className="text-warning">Improve:</span> <span className="text-text-muted">{detail.review.improvements}</span></p>}
          <p className="text-[10px] text-text-dim">{detail.review.reviewer_name ?? 'Unknown'} · {formatTimeAgo(detail.review.created_at)}</p>
        </div>
      )}

      {!detail ? (
        <p className="text-[11px] text-text-dim">Loading reports…</p>
      ) : detail.reports.length > 0 ? (
        <ul className="space-y-1.5">
          {detail.reports.slice(0, 8).map((r) => (
            <li key={r.id} className="text-xs text-text-muted bg-bg-inset border border-border rounded-lg p-2.5">
              <span className="italic">“{r.raw_message}”</span>
              <div className="text-[10px] text-text-dim mt-1">
                {r.source.replace(/_/g, ' ')}{r.reporter_name ? ` · ${r.reporter_name}` : ''} · {formatTimeAgo(r.reported_at ?? r.created_at)}
                {r.classifier ? ` · ${r.classifier === 'gemini' ? 'AI' : 'keyword'} extraction` : ''}{r.is_duplicate ? ' · merged' : ''}
              </div>
            </li>
          ))}
          {detail.reports.length > 8 && <li className="text-[11px] text-text-dim">+{detail.reports.length - 8} older reports</li>}
        </ul>
      ) : (
        <p className="text-[11px] text-text-dim">No reports attached.</p>
      )}
    </div>
  );
}

const TIMELINE_COLOR: Record<string, string> = {
  created: '#3b82f6', created_from_report: '#3b82f6', merged: '#8b5cf6', merged_into: '#8b5cf6', ai_recommendation: '#06b6d4',
  approved: '#22c55e', status_changed: '#f59e0b', escalated: '#ef4444', rejected: '#ef4444', cancelled: '#ef4444',
  en_route: '#3b82f6', arrived: '#a855f7', completed: '#22c55e', reassigned: '#f97316', possible_duplicate: '#eab308',
  location_verified: '#22c55e', location_corrected: '#eab308', duplicate_dismissed: '#64748b',
};

function describe(entry: AuditEntry): string {
  const d = entry.details ?? {};
  const str = (k: string) => (typeof d[k] === 'string' ? (d[k] as string) : '');
  switch (entry.action) {
    case 'created': return 'Incident created';
    case 'created_from_report': return `Created from report (${str('classifier') === 'gemini' ? 'AI' : 'keyword'} extraction)`;
    case 'merged': return 'Corroborating report merged';
    case 'merged_into': return 'Merged into another incident as a duplicate';
    case 'possible_duplicate': return 'Flagged as a possible duplicate';
    case 'duplicate_dismissed': return 'Kept separate after duplicate review';
    case 'location_verified': return 'Location verified by coordinator';
    case 'location_corrected': return 'Location corrected by coordinator';
    case 'ai_recommendation': return 'Unit recommendations generated';
    case 'status_changed':
      return entry.entity_type === 'incident'
        ? `Status: ${STATUS_CONFIG[str('from') as IncidentStatus]?.label ?? str('from')} → ${STATUS_CONFIG[str('to') as IncidentStatus]?.label ?? str('to')}${d.automatic ? ' (automatic)' : ''}`
        : `Status changed to ${str('to')}`;
    case 'escalated': return `Escalated ${str('from')} → ${str('to')}`;
    case 'risk_reassessed': return `Risk re-assessed: model ${str('model_class_before') || '—'} → ${str('model_class_after')}`;
    case 'approved': return `Approved & dispatched ${str('resource_name')}`;
    case 'rejected': return `Rejected ${str('resource_name')}`;
    case 'cancelled': return `Cancelled ${str('resource_name')}`;
    case 'en_route': return `${str('resource_name')} en route`;
    case 'arrived': return `${str('resource_name')} arrived on scene`;
    case 'completed': return `${str('resource_name')} released`;
    case 'reassigned': return `${str('resource_name')} reassigned to another incident`;
    case 'road_blocked': return `Road blocked${str('road_name') ? `: ${str('road_name')}` : ''}`;
    case 'road_cleared': return `Road reopened${str('road_name') ? `: ${str('road_name')}` : ''}`;
    default: return entry.action.replace(/_/g, ' ');
  }
}

function Timeline({ incidentId, changeKey }: { incidentId: string; changeKey: string }) {
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const ctrl = new AbortController();
    fetchTimeline(incidentId, ctrl.signal)
      .then((rows) => { setEntries(rows); setError(''); })
      .catch((err) => { if ((err as Error).name !== 'AbortError') setError((err as Error).message); });
    return () => ctrl.abort();
  }, [incidentId, changeKey]);

  if (error) return <p className="text-xs text-red-300">{error}</p>;
  if (!entries) return <p className="text-[11px] text-text-dim">Loading activity…</p>;
  if (entries.length === 0) return <p className="text-xs text-text-dim">No recorded activity yet.</p>;

  return (
    <ol className="relative border-l border-border ml-1 space-y-3">
      {entries.map((e) => (
        <li key={e.id} className="ml-3">
          <span className="absolute -left-[5px] mt-1 w-2.5 h-2.5 rounded-full" style={{ background: TIMELINE_COLOR[e.action] ?? '#64748b' }} />
          <div className="text-xs text-text">{describe(e)}</div>
          <div className="text-[10px] text-text-dim">
            {new Date(e.created_at).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })} · {e.user_name ?? 'System'}
            {typeof e.details?.note === 'string' && e.details.note ? ` · “${e.details.note}”` : ''}
          </div>
        </li>
      ))}
    </ol>
  );
}
