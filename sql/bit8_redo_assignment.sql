-- Feature 1 — auto-distributed redo assignment.
--
-- Which reviewer owns a given failed mask's re-annotation. Distribution is
-- even-by-count across all current project members (see
-- rebalanceRedoAssignments in src/lib/projects.js); there is deliberately
-- no per-category column — an earlier design assigned by class and was
-- replaced before it shipped, so there's nothing to migrate away from.
--
-- NOTE: this column was originally applied directly against the hosted
-- Supabase instance and never checked in. This file is that DDL, written
-- idempotently so it's a no-op on the existing database while still
-- putting the schema under version control for a fresh environment.

alter table masks
  add column if not exists assigned_to uuid references reviewers (id);

-- on delete set null: a reviewer row disappearing must not take the mask
-- with it. The redo item still needs doing — it just needs a new owner,
-- and a null assigned_to is exactly what rebalanceRedoAssignments picks
-- up. (removeMember() nulls these explicitly when someone leaves a
-- project; this covers the harder case of the reviewer record itself
-- being deleted.)
do $$
begin
  alter table masks
    drop constraint if exists masks_assigned_to_fkey;
  alter table masks
    add constraint masks_assigned_to_fkey
    foreign key (assigned_to) references reviewers (id) on delete set null;
end $$;

-- Serves both hot paths: the unassigned-pool scan in
-- rebalanceRedoAssignments (project + status + assigned_to is null) and
-- one reviewer's list in fetchMyRedoAssignments (project + status +
-- assigned_to = me).
create index if not exists masks_project_status_assigned_idx
  on masks (project_id, status, assigned_to);
