import {
  INCIDENT_TYPES, PRIORITIES, INCIDENT_STATUSES, RESOURCE_TYPES, RESOURCE_STATUSES,
  ASSIGNMENT_STATUSES, ROLES, NOTIFICATION_TYPES, sqlList,
} from './constants.js';

export interface Migration {
  id: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    id: 1,
    name: 'initial_schema',
    sql: `
      CREATE TABLE resources (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL CHECK (type IN (${sqlList(RESOURCE_TYPES)})),
        name TEXT NOT NULL,
        location_lat DOUBLE PRECISION,
        location_lng DOUBLE PRECISION,
        location_name TEXT,
        location_updated_at TIMESTAMPTZ,
        location_accuracy_m DOUBLE PRECISION,
        status TEXT NOT NULL DEFAULT 'available' CHECK (status IN (${sqlList(RESOURCE_STATUSES)})),
        capacity INTEGER NOT NULL DEFAULT 1 CHECK (capacity >= 0),
        current_load INTEGER NOT NULL DEFAULT 0 CHECK (current_load >= 0),
        capabilities JSONB NOT NULL DEFAULT '[]'::jsonb,
        assigned_incident_id TEXT,
        eta_minutes INTEGER,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        full_name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN (${sqlList(ROLES)})),
        resource_id TEXT REFERENCES resources(id) ON DELETE SET NULL,
        active BOOLEAN NOT NULL DEFAULT true,
        session_version INTEGER NOT NULL DEFAULT 1,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_login_at TIMESTAMPTZ
      );

      CREATE TABLE incidents (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL CHECK (type IN (${sqlList(INCIDENT_TYPES)})),
        status TEXT NOT NULL DEFAULT 'triage' CHECK (status IN (${sqlList(INCIDENT_STATUSES)})),
        priority TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN (${sqlList(PRIORITIES)})),
        priority_score INTEGER NOT NULL DEFAULT 50 CHECK (priority_score BETWEEN 0 AND 100),
        title TEXT,
        description TEXT,
        raw_message TEXT,
        language TEXT,
        location_lat DOUBLE PRECISION,
        location_lng DOUBLE PRECISION,
        location_name TEXT,
        people_affected INTEGER NOT NULL DEFAULT 0,
        injuries INTEGER NOT NULL DEFAULT 0,
        has_children BOOLEAN NOT NULL DEFAULT false,
        has_elderly BOOLEAN NOT NULL DEFAULT false,
        has_disabled BOOLEAN NOT NULL DEFAULT false,
        urgency_indicators JSONB NOT NULL DEFAULT '[]'::jsonb,
        confidence DOUBLE PRECISION NOT NULL DEFAULT 0.5,
        corroborating_reports INTEGER NOT NULL DEFAULT 1,
        affected_radius_m DOUBLE PRECISION NOT NULL DEFAULT 100,
        escalation_deadline TIMESTAMPTZ,
        parent_incident_id TEXT REFERENCES incidents(id) ON DELETE SET NULL,
        created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        resolved_at TIMESTAMPTZ,
        closed_at TIMESTAMPTZ
      );

      ALTER TABLE resources
        ADD CONSTRAINT resources_assigned_incident_fk
        FOREIGN KEY (assigned_incident_id) REFERENCES incidents(id) ON DELETE SET NULL;

      CREATE TABLE reports (
        id TEXT PRIMARY KEY,
        client_id TEXT UNIQUE,
        incident_id TEXT REFERENCES incidents(id) ON DELETE CASCADE,
        raw_message TEXT NOT NULL,
        language TEXT,
        source TEXT NOT NULL DEFAULT 'manual',
        reporter_name TEXT,
        reporter_phone TEXT,
        reporter_lat DOUBLE PRECISION,
        reporter_lng DOUBLE PRECISION,
        submitted_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        extracted_data JSONB,
        classifier TEXT,
        confidence DOUBLE PRECISION NOT NULL DEFAULT 0.5,
        is_duplicate BOOLEAN NOT NULL DEFAULT false,
        reported_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE resource_assignments (
        id TEXT PRIMARY KEY,
        incident_id TEXT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
        resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'recommended' CHECK (status IN (${sqlList(ASSIGNMENT_STATUSES)})),
        ai_score DOUBLE PRECISION,
        ai_reasoning TEXT,
        eta_minutes INTEGER,
        coordinator_action TEXT,
        coordinator_notes TEXT,
        decided_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE blocked_roads (
        id TEXT PRIMARY KEY,
        incident_id TEXT REFERENCES incidents(id) ON DELETE CASCADE,
        start_lat DOUBLE PRECISION NOT NULL,
        start_lng DOUBLE PRECISION NOT NULL,
        end_lat DOUBLE PRECISION NOT NULL,
        end_lng DOUBLE PRECISION NOT NULL,
        road_name TEXT,
        reason TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      -- No foreign keys: audit entries must survive deletion of what they describe.
      CREATE TABLE audit_log (
        id TEXT PRIMARY KEY,
        entity_type TEXT NOT NULL,
        entity_id TEXT,
        incident_id TEXT,
        user_id TEXT,
        user_name TEXT,
        action TEXT NOT NULL,
        details JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE notifications (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL CHECK (type IN (${sqlList(NOTIFICATION_TYPES)})),
        title TEXT NOT NULL,
        message TEXT NOT NULL,
        incident_id TEXT REFERENCES incidents(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE notification_reads (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        notification_id TEXT NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
        read_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (user_id, notification_id)
      );

      CREATE TABLE incident_reviews (
        id TEXT PRIMARY KEY,
        incident_id TEXT NOT NULL UNIQUE REFERENCES incidents(id) ON DELETE CASCADE,
        reviewer_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        reviewer_name TEXT,
        summary TEXT NOT NULL,
        went_well TEXT,
        improvements TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE INDEX incidents_status_idx ON incidents (status);
      CREATE INDEX incidents_parent_idx ON incidents (parent_incident_id);
      CREATE INDEX reports_incident_idx ON reports (incident_id);
      CREATE INDEX assignments_incident_idx ON resource_assignments (incident_id);
      CREATE INDEX assignments_resource_idx ON resource_assignments (resource_id);
      CREATE INDEX audit_created_idx ON audit_log (created_at DESC);
      CREATE INDEX audit_incident_idx ON audit_log (incident_id);
      CREATE INDEX notifications_created_idx ON notifications (created_at DESC);
    `,
  },
  {
    id: 2,
    name: 'incident_location_source',
    sql: 'ALTER TABLE incidents ADD COLUMN location_source TEXT;',
  },
  {
    // XGBoost risk assessment (model class, derived score, probabilities, evidence, model version).
    // Optional: incidents created before the model, or when inference fails, may have none.
    id: 3,
    name: 'incident_risk_assessment',
    sql: 'ALTER TABLE incidents ADD COLUMN risk_assessment JSONB;',
  },
  {
    // Global allocation optimizer: per-proposal explanation metadata, and a database backstop for
    // "a resource has at most one active assignment". Existing duplicates are reported, not altered.
    id: 4,
    name: 'allocation_metadata_and_single_active_assignment',
    sql: `
      ALTER TABLE resource_assignments ADD COLUMN allocation JSONB;
      DO $$
      DECLARE dup TEXT;
      BEGIN
        SELECT string_agg(resource_id || ' (' || n || ' active)', ', ') INTO dup FROM (
          SELECT resource_id, COUNT(*) AS n FROM resource_assignments
          WHERE status IN ('dispatched', 'en_route', 'arrived') GROUP BY resource_id HAVING COUNT(*) > 1
        ) d;
        IF dup IS NOT NULL THEN
          RAISE EXCEPTION 'Cannot enforce one active assignment per resource; resolve these first: %', dup;
        END IF;
      END $$;
      CREATE UNIQUE INDEX resource_one_active_assignment
        ON resource_assignments (resource_id) WHERE status IN ('dispatched', 'en_route', 'arrived');
    `,
  },
  {
    // Location provenance/confidence, duplicate detection by recent activity, and review flags.
    id: 5,
    name: 'location_provenance_and_dedup',
    sql: `
      ALTER TABLE incidents ADD COLUMN location_meta JSONB;
      ALTER TABLE incidents ADD COLUMN last_report_at TIMESTAMPTZ;
      ALTER TABLE incidents ADD COLUMN dedup_review JSONB;
      UPDATE incidents i SET last_report_at = COALESCE(
        (SELECT MAX(r.reported_at) FROM reports r WHERE r.incident_id = i.id), i.created_at);
      ALTER TABLE reports ADD COLUMN reporter_accuracy_m DOUBLE PRECISION;
      ALTER TABLE reports ADD COLUMN location_meta JSONB;
      ALTER TABLE reports ADD COLUMN dedup JSONB;
      CREATE INDEX incidents_active_activity_idx ON incidents (status, last_report_at);
    `,
  },
];
