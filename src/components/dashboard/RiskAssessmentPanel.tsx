import { Check, AlertTriangle, Info, UserCheck } from 'lucide-react';
import { PRIORITY_CONFIG } from '../../utils/helpers';
import type { Incident, Priority, RiskClass } from '../../types';

const CLASS_ORDER: RiskClass[] = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
const toPriority = (c: RiskClass) => c.toLowerCase() as Priority;

/**
 * Coordinator view of the XGBoost risk assessment stored on the incident.
 * Everything shown comes from the backend prediction; nothing is computed or assumed here.
 */
export function RiskAssessmentPanel({ incident }: { incident: Incident }) {
  const a = incident.risk_assessment;

  if (!a) {
    return (
      <div className="p-3 rounded-lg border border-border bg-bg-inset text-[11px] text-text-dim flex items-start gap-2">
        <Info className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
        No AI risk assessment: this incident was created before the risk model was added. Priority shown is the original value.
      </div>
    );
  }

  if (a.status === 'unavailable') {
    return (
      <div className="p-3 rounded-lg border border-warning/30 bg-warning/10 text-xs text-warning flex items-start gap-2">
        <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
        <div>
          <div className="font-semibold">AI risk assessment unavailable</div>
          <div className="text-warning/90 mt-0.5">
            The risk model could not score this incident. The priority shown ({incident.priority}) is a default safety value, not a model result. Assess manually.
          </div>
        </div>
      </div>
    );
  }

  const cfg = PRIORITY_CONFIG[toPriority(a.model_class)];
  const operationalDiffers = incident.priority !== toPriority(a.model_class);

  return (
    <div className="space-y-3">
      <div className="flex items-end justify-between gap-3">
        <div>
          <div className="text-[10px] uppercase tracking-wide text-text-dim">Model risk score</div>
          <div className="text-3xl font-bold leading-none mt-1 tabular-nums" style={{ color: cfg.color }}>
            {a.model_score}<span className="text-sm font-medium text-text-dim"> / 100</span>
          </div>
        </div>
        <span className="px-2.5 py-1 rounded-md text-xs font-bold tracking-wide border" style={{ background: cfg.bg, color: cfg.color, borderColor: `${cfg.color}55` }}>
          {a.model_class}
        </span>
      </div>

      <div>
        <div className="text-[10px] uppercase tracking-wide text-text-dim mb-1">Class probabilities</div>
        <div className="flex h-2 rounded-full overflow-hidden bg-border" role="img" aria-label={`Model class probabilities: ${CLASS_ORDER.map((c) => `${c} ${Math.round(a.probabilities[c] * 100)}%`).join(', ')}`}>
          {CLASS_ORDER.map((c) => (
            <span key={c} style={{ width: `${a.probabilities[c] * 100}%`, background: PRIORITY_CONFIG[toPriority(c)].color }} />
          ))}
        </div>
        <div className="flex justify-between text-[10px] text-text-dim mt-1">
          {CLASS_ORDER.map((c) => <span key={c}>{c} {Math.round(a.probabilities[c] * 100)}%</span>)}
        </div>
      </div>

      <div className="text-[10px] uppercase tracking-wide text-text-dim">Evidence extracted from {a.reports_combined > 1 ? `${a.reports_combined} reports` : 'the report'}</div>
      {a.factors.length > 0 ? (
        <ul className="space-y-1 -mt-1.5">
          {a.factors.map((f) => (
            <li key={f} className="flex items-start gap-1.5 text-xs text-text-muted">
              <Check className="w-3.5 h-3.5 text-success flex-shrink-0 mt-0.5" /> {f}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-text-dim">No casualty, hazard or urgency evidence was extracted from the report.</p>
      )}

      {operationalDiffers && (
        <p className="text-[11px] text-warning flex items-start gap-1">
          <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
          Operational priority is now <span className="font-semibold uppercase">{incident.priority}</span> (escalated after the model assessment).
        </p>
      )}

      <p className="text-[11px] text-text-muted flex items-start gap-1.5 pt-2 border-t border-border">
        <UserCheck className="w-3.5 h-3.5 flex-shrink-0 mt-0.5 text-text-dim" />
        The model supports triage; the coordinator decides what is dispatched.
      </p>
      <p className="text-[10px] text-text-dim leading-snug">
        Score is a weighted sum of the class probabilities, not the probability of an emergency. XGBoost proof of concept:
        95.57% test accuracy on a generated evaluation set labelled by a deterministic rubric; not a validated real-world severity predictor.
      </p>
    </div>
  );
}
