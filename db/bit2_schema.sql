-- ============================================================
-- SegCheck — Bit 2: Database schema
-- Run this in the Supabase SQL editor (one project = Singapore region).
-- Safe to re-run: uses IF NOT EXISTS / idempotent guards where possible.
-- ============================================================

-- ---------- 1. ENUMS ----------
-- The automatic IoU/containment check produces one of these (a *suggestion*).
do $$ begin
  create type auto_flag as enum ('pass', 'fail', 'borderline');
exception when duplicate_object then null; end $$;

-- A reviewer confirms/overrides. 'pending' = not yet reviewed.
do $$ begin
  create type review_decision as enum ('pending', 'pass', 'fail');
exception when duplicate_object then null; end $$;

-- What kind of event a review_logs row records (append-only audit trail).
do $$ begin
  create type log_action as enum (
    'auto_check',      -- system wrote the suggested auto_flag
    'confirm',         -- reviewer agreed with the suggestion
    'override',        -- reviewer disagreed and set a different decision
    'batch_confirm',   -- same-category batch confirm
    'reject_image',    -- whole-image reject (cascades to instances)
    'fix_applied',     -- manual pixel-clip done
    'bbox_flagged'     -- ground-truth box itself marked suspect
  );
exception when duplicate_object then null; end $$;

-- ---------- 2. TABLES ----------

-- reviewers: keyed 1:1 to Supabase auth.users. is_lead = final say on disputes.
create table if not exists reviewers (
  id           uuid primary key references auth.users (id) on delete cascade,
  display_name text not null,
  is_lead      boolean not null default false,
  created_at   timestamptz not null default now()
);

-- images: one source image. Re-uploading the same stem bumps mask_version,
-- it never creates a duplicate (enforced by unique filename + app logic).
create table if not exists images (
  id                   uuid primary key default gen_random_uuid(),
  filename             text not null unique,          -- shared stem, the match key
  original_path        text,                           -- Storage path to the original image
  mask_path            text,                           -- Storage path to the SAM output
  mask_version         integer not null default 1,
  whole_image_rejected boolean not null default false, -- cascades to instances
  uploaded_by          uuid references reviewers (id),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

-- instances: one object/mask per row.
create table if not exists instances (
  id                 uuid primary key default gen_random_uuid(),
  image_id           uuid not null references images (id) on delete cascade,
  category           text,
  bbox               jsonb,            -- ground-truth box {x, y, w, h}
  mask_version       integer not null default 1,
  iou_score          numeric(5,4),     -- 0.0000–1.0000
  containment_score  numeric(5,4),     -- fraction of mask pixels inside the bbox
  auto_flag          auto_flag,        -- suggested pass/fail/borderline
  reviewer_decision  review_decision not null default 'pending',
  reviewed_by        uuid references reviewers (id),
  fix_applied        boolean not null default false,
  bbox_quality_flag  boolean not null default false,  -- SEPARATE from mask decision
  notes              text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index if not exists idx_instances_image_id on instances (image_id);
create index if not exists idx_instances_category on instances (category);

-- review_logs: APPEND-ONLY audit trail. Basis for the methodology CSV.
create table if not exists review_logs (
  id              uuid primary key default gen_random_uuid(),
  instance_id     uuid references instances (id) on delete set null,
  image_id        uuid references images (id) on delete set null,
  reviewer_id     uuid references reviewers (id),
  action          log_action not null,
  decision_before review_decision,
  decision_after  review_decision,
  detail          jsonb,            -- free-form context (iou, category, etc.)
  created_at      timestamptz not null default now()
);

create index if not exists idx_logs_instance_id on review_logs (instance_id);
create index if not exists idx_logs_image_id on review_logs (image_id);

-- assignments: the cluster/category split of confirmed-fails across reviewers.
create table if not exists assignments (
  id          uuid primary key default gen_random_uuid(),
  reviewer_id uuid not null references reviewers (id) on delete cascade,
  category    text,                         -- the cluster/category bucket
  instance_id uuid references instances (id) on delete cascade,
  status      text not null default 'open', -- open | in_progress | done
  created_at  timestamptz not null default now()
);

create index if not exists idx_assignments_reviewer on assignments (reviewer_id);

-- ---------- 3. ROW-LEVEL SECURITY ----------
-- Enable RLS on every table. With only 3 trusted reviewers, the policy is:
-- "any authenticated user can do anything." Tighten later if needed.
alter table reviewers   enable row level security;
alter table images      enable row level security;
alter table instances   enable row level security;
alter table review_logs enable row level security;
alter table assignments enable row level security;

do $$
declare t text;
begin
  foreach t in array array['reviewers','images','instances','review_logs','assignments']
  loop
    execute format(
      'create policy %I on %I for all to authenticated using (true) with check (true)',
      'authenticated_all_' || t, t
    );
  end loop;
exception when duplicate_object then null;
end $$;

-- review_logs is append-only: allow INSERT + SELECT, block UPDATE/DELETE.
-- (The blanket policy above is dropped for this table and replaced.)
drop policy if exists authenticated_all_review_logs on review_logs;
create policy logs_insert on review_logs for insert to authenticated with check (true);
create policy logs_select on review_logs for select to authenticated using (true);
-- No update/delete policy => those actions are denied for authenticated users.
