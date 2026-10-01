import { ESCALATION_THRESHOLD_MIN } from '../constants.js';

interface IncidentForEscalation {
  id: string;
  type: string;
  status: string;
  priority: string;
  priority_score: number;
  created_at: string | Date;
  escalation_deadline: string | Date | null;
}

interface EscalationResult {
  incident_id: string;
  old_priority: string;
  new_priority: string;
  old_score: number;
  new_score: number;
  reason: string;
  minutes_overdue: number;
}

const THRESHOLDS: Record<string, number> = ESCALATION_THRESHOLD_MIN;

function escalatePriority(current: string, currentScore: number): { priority: string; score: number } {
  if (current === 'critical') {
    return { priority: 'critical', score: Math.min(100, currentScore + 5) };
  }
  if (current === 'high') {
    return { priority: 'critical', score: Math.max(90, currentScore + 15) };
  }
  if (current === 'medium') {
    return { priority: 'high', score: Math.max(70, currentScore + 20) };
  }
  // low
  return { priority: 'medium', score: Math.max(40, currentScore + 25) };
}

/**
 * Check all active incidents for overdue escalation.
 * Returns a list of incidents that should be escalated.
 */
export function checkEscalations(incidents: IncidentForEscalation[]): EscalationResult[] {
  const now = Date.now();
  const results: EscalationResult[] = [];

  for (const incident of incidents) {
    // Only incidents still waiting for a response milestone (triage or awaiting arrival) escalate
    if (incident.status !== 'triage' && incident.status !== 'dispatched') continue;

    // If already at max, skip
    if (incident.priority === 'critical' && incident.priority_score >= 100) continue;

    const thresholdMinutes = THRESHOLDS[incident.type] ?? 45;

    // Use escalation_deadline if set, otherwise compute from created_at + threshold
    let deadlineMs: number;
    if (incident.escalation_deadline) {
      deadlineMs = new Date(incident.escalation_deadline).getTime();
    } else {
      deadlineMs = new Date(incident.created_at).getTime() + thresholdMinutes * 60 * 1000;
    }

    if (now > deadlineMs) {
      const minutesOverdue = Math.round((now - deadlineMs) / 60000);
      const { priority, score } = escalatePriority(incident.priority, incident.priority_score);

      results.push({
        incident_id: incident.id,
        old_priority: incident.priority,
        new_priority: priority,
        old_score: incident.priority_score,
        new_score: score,
        reason: `Unattended ${incident.type} exceeded ${thresholdMinutes}-minute threshold by ${minutesOverdue} minutes`,
        minutes_overdue: minutesOverdue,
      });
    }
  }

  return results;
}
