CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE SCHEMA IF NOT EXISTS auth;

CREATE OR REPLACE FUNCTION auth.uid()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;

CREATE TABLE projects (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  owner_id uuid
);

CREATE TABLE reviewers (
  id uuid PRIMARY KEY,
  email text NOT NULL
);

CREATE TABLE project_members (
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  reviewer_id uuid NOT NULL REFERENCES reviewers(id) ON DELETE CASCADE,
  PRIMARY KEY (project_id, reviewer_id)
);

CREATE TABLE masks (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('pending', 'pass', 'fail')),
  assigned_to uuid REFERENCES reviewers(id),
  storage_path text
);

CREATE TABLE review_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  mask_id uuid NOT NULL REFERENCES masks(id) ON DELETE CASCADE,
  reviewer_id uuid NOT NULL REFERENCES reviewers(id),
  action text NOT NULL,
  status_after text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'
);
