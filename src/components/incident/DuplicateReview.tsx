import { useState } from 'react';
import { Copy, GitMerge, SplitSquareHorizontal } from 'lucide-react';
import { useStore } from '../../store/useStore';
import { reviewDuplicate } from '../../lib/data';
import { ApiError } from '../../lib/http';
import { INCIDENT_TYPE_CONFIG, PRIORITY_CONFIG, formatTimeAgo, shortId } from '../../utils/helpers';
import { Button } from '../ui/primitives';
import { useConfirm } from '../ui/ConfirmDialog';
import type { Incident } from '../../types';

/** Coordinator decision on a flagged possible duplicate (POST /incidents/:id/duplicate-review). */
export function DuplicateReview({ incident, canManage }: { incident: Incident; canManage: boolean }) {
  const incidents = useStore((s) => s.incidents);
  const selectAndFlyTo = useStore((s) => s.selectAndFlyTo);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const { confirm, dialog } = useConfirm();
  const review = incident.dedup_review;
  if (!review || review.status !== 'pending') return null;

  const merge = async (target: Incident) => {
    const ok = await confirm({
      title: 'Merge into the other incident?',
      body: (
        <>
          This incident&apos;s reports and evidence move to <b>{target.title}</b>, which becomes the single incident to respond to.
          This one is closed as a duplicate. Citizens tracking either report keep receiving updates from the merged incident.
        </>
      ),
      confirmLabel: 'Merge incidents',
      tone: 'warning',
    });
    if (!ok) return;
    setBusy(target.id);
    setError('');
    try {
      await reviewDuplicate(incident.id, { decision: 'merge', target_incident_id: target.id });
      selectAndFlyTo(target.id, target.location_lat, target.location_lng);
    } catch (err) {
      setError(err instanceof ApiError && err.code === 'incident_has_units'
        ? 'Units are assigned to this incident. Release or reassign them before merging it.'
        : (err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const keepSeparate = async () => {
    setBusy('separate');
    setError('');
    try {
      await reviewDuplicate(incident.id, { decision: 'separate' });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="rounded-lg border border-warning/50 bg-warning/[0.06] p-3 space-y-2.5">
      <div className="flex items-center gap-2">
        <Copy className="w-4 h-4 text-warning" />
        <span className="text-xs font-semibold text-yellow-200">Possible duplicate</span>
        <span className="text-[11px] text-text-dim ml-auto">{review.reason === 'location_change' ? 'after location change' : 'flagged at intake'} · {formatTimeAgo(review.created_at)}</span>
      </div>
      <p className="text-[11px] text-text-muted">This may be the same emergency as another active incident. Merge them so units are not sent twice, or keep them separate.</p>
      <ul className="space-y-1.5">
        {review.candidates.map((c) => {
          const other = incidents.find((i) => i.id === c.incident_id);
          return (
            <li key={c.incident_id} className="rounded-md border border-border bg-bg-inset p-2.5 space-y-1.5">
              {other ? (
                <button type="button" onClick={() => selectAndFlyTo(other.id, other.location_lat, other.location_lng)} className="text-left w-full cursor-pointer group">
                  <div className="text-xs font-semibold group-hover:underline truncate">{INCIDENT_TYPE_CONFIG[other.type].icon} {other.title}</div>
                  <div className="text-[11px] text-text-dim truncate">
                    <span style={{ color: PRIORITY_CONFIG[other.priority].color }}>{PRIORITY_CONFIG[other.priority].label}</span>
                    {' · '}#{shortId(other.id)} · {other.location_name ?? 'unknown location'}
                  </div>
                </button>
              ) : (
                <div className="text-xs text-text-dim">Incident #{shortId(c.incident_id)} is no longer active.</div>
              )}
              <div className="text-[11px] text-text-muted">
                Similarity score {Math.round(c.score * 100)}%{c.reasons.length ? ` — ${c.reasons.slice(0, 2).join('; ')}` : ''}
              </div>
              {canManage && other && (
                <Button size="sm" variant="warning" busy={busy === other.id} disabled={busy !== null && busy !== other.id} icon={<GitMerge className="w-3.5 h-3.5" />} onClick={() => merge(other)}>
                  Merge into this incident
                </Button>
              )}
            </li>
          );
        })}
      </ul>
      {error && <p className="text-xs text-red-300">{error}</p>}
      {canManage && (
        <Button size="sm" className="w-full" busy={busy === 'separate'} disabled={busy !== null && busy !== 'separate'} icon={<SplitSquareHorizontal className="w-3.5 h-3.5" />} onClick={keepSeparate}>
          Keep as a separate incident
        </Button>
      )}
      {dialog}
    </div>
  );
}
