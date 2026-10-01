import { CheckCircle2, CircleDashed, Clock3, Home, XCircle } from 'lucide-react';
import { RESOURCE_TYPE_CONFIG, capabilityLabel, slotPurpose } from '../../utils/helpers';
import type { SlotState, SlotStatus } from '../../lib/slots';
import { LoadingBlock } from '../ui/primitives';
import { cx } from '../../utils/cx';
import type { IncidentDemand, Resource, ResourceAssignment } from '../../types';

const STATE_UI: Record<SlotState, { icon: typeof CheckCircle2; cls: string; label: string }> = {
  covered: { icon: CheckCircle2, cls: 'text-success', label: 'Covered' },
  proposed: { icon: Clock3, cls: 'text-blue-300', label: 'Awaiting approval' },
  open: { icon: CircleDashed, cls: 'text-text-dim', label: 'Open' },
  unavailable: { icon: XCircle, cls: 'text-red-300', label: 'No unit available' },
};

const UNIT_STATUS: Record<string, string> = { dispatched: 'dispatched', en_route: 'en route', arrived: 'on scene', recommended: 'proposed' };

export function RequiredResponse({ demand, error, statuses, extra, resourcesById }: {
  demand: IncidentDemand | null;
  error: string;
  statuses: SlotStatus[];
  extra: ResourceAssignment[];
  resourcesById: Map<string, Resource>;
}) {
  if (error) return <p className="text-xs text-red-300">Could not load requirements: {error}</p>;
  if (!demand) return <LoadingBlock label="Loading requirements…" />;
  if (demand.slots.length === 0) return <p className="text-xs text-text-dim">No mobile units are required by the response policy for this incident.</p>;

  const covered = statuses.filter((s) => s.state === 'covered').length;
  const proposed = statuses.filter((s) => s.state === 'proposed').length;

  return (
    <div className="space-y-2.5">
      <div className="flex items-center gap-2 text-xs">
        <div className="flex-1 h-1.5 rounded-full bg-bg-inset overflow-hidden flex" aria-hidden>
          <span className="bg-success" style={{ width: `${(covered / statuses.length) * 100}%` }} />
          <span className="bg-accent/70" style={{ width: `${(proposed / statuses.length) * 100}%` }} />
        </div>
        <span className="text-text-muted whitespace-nowrap tabular-nums">
          <b className="text-text">{covered}</b> of {statuses.length} covered{proposed ? ` · ${proposed} proposed` : ''}
        </span>
      </div>

      <ul className="divide-y divide-border rounded-lg border border-border bg-bg-inset">
        {statuses.map(({ slot, state, assignment, reason }) => {
          const ui = STATE_UI[state];
          const cfg = RESOURCE_TYPE_CONFIG[slot.resource_type];
          const unit = assignment ? resourcesById.get(assignment.resource_id)?.name ?? assignment.resource_name : null;
          return (
            <li key={slot.id} className="flex items-start gap-2.5 px-3 py-2">
              <ui.icon className={cx('w-4 h-4 mt-0.5 flex-shrink-0', ui.cls)} aria-label={ui.label} />
              <div className="min-w-0 flex-1">
                <div className="text-xs font-medium flex items-center gap-1.5 flex-wrap">
                  <span aria-hidden>{cfg.icon}</span> {cfg.label}{slot.index > 1 ? ` #${slot.index}` : ''}
                  {slot.required_caps.map((c) => (
                    <span key={c} className="text-[10px] font-normal px-1 rounded bg-bg-card-hover text-text-muted">needs {capabilityLabel(c)}</span>
                  ))}
                  {!slot.essential && <span className="text-[10px] font-normal text-text-dim">support</span>}
                </div>
                <div className="text-[11px] text-text-dim">{slotPurpose(slot.purpose)}</div>
              </div>
              <div className="text-right flex-shrink-0 max-w-[45%]">
                <div className={cx('text-[11px] font-medium', ui.cls)}>{ui.label}</div>
                {unit && <div className="text-[11px] text-text-muted truncate">{unit} · {UNIT_STATUS[assignment!.status]}</div>}
                {reason && <div className="text-[10px] text-text-dim">{reason}</div>}
              </div>
            </li>
          );
        })}
      </ul>

      {extra.length > 0 && (
        <p className="text-[11px] text-text-dim">
          Also assigned beyond the policy requirements: {extra.map((a) => resourcesById.get(a.resource_id)?.name ?? a.resource_name).join(', ')}.
        </p>
      )}
      {demand.shelter_need !== 0 && (
        <p className="text-[11px] text-text-muted flex items-center gap-1.5">
          <Home className="w-3.5 h-3.5 text-text-dim" />
          Shelter capacity needed: {demand.shelter_need > 0 ? `${demand.shelter_need} people` : 'evacuation reported, number unknown'}
        </p>
      )}
      <p className="text-[10px] text-text-dim">Requirements come from the same demand model the allocation optimizer uses.</p>
    </div>
  );
}
