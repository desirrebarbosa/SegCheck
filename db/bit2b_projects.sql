-- ============================================================
-- SegCheck — Bit 2b: Projects + per-project membership & isolation
-- Run AFTER bit2_schema.sql, in the Supabase SQL editor. Idempotent.
--
-- Model (decided):
--   * Any signed-in reviewer can create a project and becomes its owner+lead.
--   * A project owns its own images/instances/assignments/review_logs.
--   * Reviewers only see projects they are a MEMBER of (RLS-enforced).
--   * Members are added by email; "lead" is per-project (lives on the membership).
-- ============================================================

-- ---------- reviewers: store email so members can be added by email ----------
alter table reviewers add column if not exists email text;

-- ---------- projects ----------
create table if not exists projects (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  owner_id   uuid not null references reviewers (id) on delete restrict,
  created_at timestamptz not null default now()
);

-- ---------- project_members (per-project lead lives here) ----------
create table if not exists project_members (
  project_id  uuid not null references projects (id) on delete cascade,
  reviewer_id uuid not null references reviewers (id) on delete cascade,
  is_lead     boolean not null default false,
  added_at    timestamptz not null default now(),
  primary key (project_id, reviewer_id)
);

-- ---------- scope every data table to a project ----------
alter table images      add column if not exists project_id uuid references projects (id) on delete cascade;
alter table instances   add column if not exists project_id uuid references projects (id) on delete cascade;
alter table assignments add column if not exists project_id uuid references projects (id) on delete cascade;
alter table review_logs add column if not exists project_id uuid references projects (id) on delete cascade;

create index if not exists idx_images_project on images (project_id);
create index if not exists idx_instances_project on instances (project_id);
create index if not exists idx_assignments_project on assignments (project_id);
create index if not exists idx_logs_project on review_logs (project_id);

-- ---------- membership helpers ----------
-- SECURITY DEFINER => these run with elevated rights and bypass RLS, which
-- avoids infinite recursion when policies on project_members check membership.
create or replace function is_project_member(pid uuid)
returns boolean language sql security definer stable
set search_path = public as $$
  select exists (
    select 1 from project_members m
    where m.project_id = pid and m.reviewer_id = auth.uid()
  );
$$;

create or replace function is_project_lead(pid uuid)
returns boolean language sql security definer stable
set search_path = public as $$
  select exists (
    select 1 from project_members m
    where m.project_id = pid and m.reviewer_id = auth.uid() and m.is_lead
  );
$$;

-- ---------- RLS on the new tables ----------
alter table projects        enable row level security;
alter table project_members enable row level security;

-- Drop the blanket "any authenticated" policies from Bit 2; replace with
-- membership-scoped ones below.
drop policy if exists authenticated_all_reviewers   on reviewers;
drop policy if exists authenticated_all_images       on images;
drop policy if exists authenticated_all_instances    on instances;
drop policy if exists authenticated_all_assignments  on assignments;
drop policy if exists logs_insert                    on review_logs;
drop policy if exists logs_select                    on review_logs;

-- reviewers: a global account directory. Readable by any signed-in user
-- (needed to add members by email); each user only writes their own row.
drop policy if exists reviewers_select on reviewers;
create policy reviewers_select on reviewers for select to authenticated using (true);
drop policy if exists reviewers_insert_self on reviewers;
create policy reviewers_insert_self on reviewers for insert to authenticated with check (id = auth.uid());
drop policy if exists reviewers_update_self on reviewers;
create policy reviewers_update_self on reviewers for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

-- projects: see if member; anyone may create (as owner); only a lead may edit/delete.
drop policy if exists projects_select on projects;
create policy projects_select on projects for select to authenticated using (is_project_member(id));
drop policy if exists projects_insert on projects;
create policy projects_insert on projects for insert to authenticated with check (owner_id = auth.uid());
drop policy if exists projects_update on projects;
create policy projects_update on projects for update to authenticated using (is_project_lead(id)) with check (is_project_lead(id));
drop policy if exists projects_delete on projects;
create policy projects_delete on projects for delete to authenticated using (is_project_lead(id));

-- project_members: members can see the roster; leads manage it.
-- The owner-bootstrap branch lets a fresh owner add themselves as the first
-- (lead) member, before any membership row exists.
drop policy if exists members_select on project_members;
create policy members_select on project_members for select to authenticated using (is_project_member(project_id));
drop policy if exists members_insert on project_members;
create policy members_insert on project_members for insert to authenticated with check (
  is_project_lead(project_id)
  or exists (select 1 from projects p where p.id = project_id and p.owner_id = auth.uid())
);
drop policy if exists members_update on project_members;
create policy members_update on project_members for update to authenticated using (is_project_lead(project_id)) with check (is_project_lead(project_id));
drop policy if exists members_delete on project_members;
create policy members_delete on project_members for delete to authenticated using (is_project_lead(project_id));

-- data tables: full access to project members only.
create policy images_member_all on images for all to authenticated
  using (is_project_member(project_id)) with check (is_project_member(project_id));
create policy instances_member_all on instances for all to authenticated
  using (is_project_member(project_id)) with check (is_project_member(project_id));
create policy assignments_member_all on assignments for all to authenticated
  using (is_project_member(project_id)) with check (is_project_member(project_id));

-- review_logs: append-only AND member-scoped (insert + select, no update/delete).
create policy logs_member_insert on review_logs for insert to authenticated
  with check (is_project_member(project_id));
create policy logs_member_select on review_logs for select to authenticated
  using (is_project_member(project_id));
