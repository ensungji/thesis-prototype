-- 16 · Activities: word lists made by an admin, run by teachers as a session
-- Phase 1, part 1.
--
--   activities       one list: name, description, level, status
--   activity_words   its words in order, each with its own hold time (5–60 s, default 20)
--
-- Who can do what (RLS):
--   admin    reads everything; creates drafts; edits and deletes DRAFTS;
--            publishes; hides / un-hides
--   teacher  reads PUBLISHED activities and their words, nothing else
--   anon     nothing
--
-- The edit lock is a trigger, so it holds for everyone (also the service role
-- and the SQL editor):
--   draft      anything can change. Publishing needs at least one word and
--              sets published_at.
--   published  only published ↔ hidden. No edits, no going back to draft
--   hidden     (duplicate_activity, migration 17, makes an editable copy).
--   words      can only be added, changed or removed while the activity is a draft.
-- Only drafts can be deleted (RLS); a published activity is hidden instead.
--
-- Sessions are never tied to this table: sessions.activity_id (migration 18)
-- is ON DELETE SET NULL, and the words and the name are copied into the
-- session when it starts (migration 19). Hiding or deleting an activity
-- changes nothing in a session, its words, results or recordings.
--
-- level uses the word bank's difficulty values (easy / medium / hard), or empty.

begin;

-- ── Tables ───────────────────────────────────────────────────────────────────

create table public.activities (
  id           uuid primary key default gen_random_uuid(),
  name         text not null
               constraint activities_name_length check (char_length(btrim(name)) between 1 and 100),
  description  text
               constraint activities_description_length check (char_length(description) <= 1000),
  level        text
               constraint activities_level_check check (level in ('easy', 'medium', 'hard')),
  status       text not null default 'draft'
               constraint activities_status_check check (status in ('draft', 'published', 'hidden')),
  created_by   uuid default auth.uid() references public.profiles (id) on delete set null,
  created_at   timestamptz not null default now(),
  published_at timestamptz
);

create table public.activity_words (
  id               uuid primary key default gen_random_uuid(),
  activity_id      uuid not null references public.activities (id) on delete cascade,
  position         int not null
                   constraint activity_words_position_check check (position >= 0),
  word             text not null
                   constraint activity_words_word_check check (word ~ '^[A-Z]{1,40}$'),
  duration_seconds int not null default 20
                   constraint activity_words_duration_range check (duration_seconds between 5 and 60),
  -- deferred: a reorder can swap positions inside one statement / transaction
  constraint activity_words_position_unique unique (activity_id, position)
    deferrable initially deferred
);

-- ── Edit lock: activities ────────────────────────────────────────────────────

create or replace function public.activities_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    if new.status <> 'draft' then
      raise exception 'A new activity must start as a draft' using errcode = '23514';
    end if;
    new.published_at := null;
    new.created_at := now();
    if auth.uid() is not null then
      new.created_by := auth.uid();
    end if;
    return new;
  end if;

  -- UPDATE. created_at never changes. created_by never changes, except to
  -- null (that's ON DELETE SET NULL when the creator's profile is deleted).
  new.created_at := old.created_at;
  if new.created_by is not null then
    new.created_by := old.created_by;
  end if;

  if old.status = 'draft' then
    if new.status = 'hidden' then
      raise exception 'Publish the activity before hiding it' using errcode = '23514';
    end if;
    if new.status = 'published' then
      if not exists (select 1 from activity_words where activity_id = new.id) then
        raise exception 'Add at least one word before publishing' using errcode = '23514';
      end if;
      new.published_at := now();
    else
      new.published_at := null;
    end if;
    return new;
  end if;

  -- published or hidden
  if new.status = 'draft' then
    raise exception 'A published activity can''t go back to draft. Duplicate it to make changes.'
      using errcode = '42501';
  end if;
  if (new.name, new.description, new.level, new.published_at)
     is distinct from (old.name, old.description, old.level, old.published_at) then
    raise exception 'A published activity can''t be edited. Duplicate it to make changes.'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger activities_guard
  before insert or update on public.activities
  for each row execute function public.activities_guard();

-- ── Edit lock: activity_words ────────────────────────────────────────────────
-- The activity row is locked FOR SHARE while a word changes, so a publish
-- can't slip in between the check and the write.
-- No activity found = it's being deleted (ON DELETE CASCADE) or doesn't exist
-- (the foreign key then refuses the insert): allowed here.

create or replace function public.activity_words_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
begin
  if tg_op in ('UPDATE', 'DELETE') then
    select status into v_status from activities where id = old.activity_id for share;
    if found and v_status <> 'draft' then
      raise exception 'Words of a published activity can''t be changed. Duplicate it to make changes.'
        using errcode = '42501';
    end if;
  end if;

  if tg_op in ('INSERT', 'UPDATE') then
    select status into v_status from activities where id = new.activity_id for share;
    if found and v_status <> 'draft' then
      raise exception 'Words of a published activity can''t be changed. Duplicate it to make changes.'
        using errcode = '42501';
    end if;
    return new;
  end if;

  return old;
end;
$$;

create trigger activity_words_guard
  before insert or update or delete on public.activity_words
  for each row execute function public.activity_words_guard();

-- Trigger functions are never called through the API
revoke execute on function public.activities_guard()     from public, anon, authenticated;
revoke execute on function public.activity_words_guard() from public, anon, authenticated;

-- ── RLS ──────────────────────────────────────────────────────────────────────

alter table public.activities     enable row level security;
alter table public.activity_words enable row level security;
revoke all on public.activities, public.activity_words from anon;

-- activities
create policy "Admins can read activities"
  on public.activities for select to authenticated
  using (public.is_admin());

create policy "Teachers can read published activities"
  on public.activities for select to authenticated
  using (status = 'published');

create policy "Admins can create activities"
  on public.activities for insert to authenticated
  with check (public.is_admin());

create policy "Admins can update activities"
  on public.activities for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());

create policy "Admins can delete draft activities"
  on public.activities for delete to authenticated
  using (public.is_admin() and status = 'draft');

-- activity_words (the trigger above limits writes to drafts)
create policy "Admins can read activity words"
  on public.activity_words for select to authenticated
  using (public.is_admin());

create policy "Teachers can read published activity words"
  on public.activity_words for select to authenticated
  using (exists (
    select 1 from public.activities a
    where a.id = activity_words.activity_id and a.status = 'published'
  ));

create policy "Admins can add activity words"
  on public.activity_words for insert to authenticated
  with check (public.is_admin());

create policy "Admins can update activity words"
  on public.activity_words for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());

create policy "Admins can delete activity words"
  on public.activity_words for delete to authenticated
  using (public.is_admin());

commit;

-- ── Check after running ──────────────────────────────────────────────────────
-- select tablename, policyname, cmd from pg_policies
-- where tablename in ('activities', 'activity_words') order by 1, 2;   -- 10 rows
--
-- ── ROLLBACK (only before migrations 17–19 have run) ────────────────────────
-- drop table if exists public.activity_words;
-- drop table if exists public.activities;
-- drop function if exists public.activity_words_guard();
-- drop function if exists public.activities_guard();
