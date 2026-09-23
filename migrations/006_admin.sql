-- What administrators did, and to what. Append-only: nothing in the API edits
-- or deletes rows here. `admin_id` is the Supabase user id (or device id when
-- auth is off); the email is kept alongside because it is what people recognise.
CREATE TABLE admin_audit (
  id           text PRIMARY KEY,
  admin_id     text NOT NULL,
  admin_email  text NOT NULL DEFAULT '',
  action       text NOT NULL,
  target_type  text NOT NULL,
  target_id    text NOT NULL,
  details      jsonb NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX admin_audit_created_idx ON admin_audit (created_at DESC);
CREATE INDEX admin_audit_target_idx ON admin_audit (target_type, target_id, created_at DESC);
