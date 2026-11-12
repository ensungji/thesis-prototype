-- 25 · Teachers own activities; the admin only oversees
--
-- Replaces the rules of migrations 16, 17 and 24 (who creates / edits / shares).
-- The edit lock itself is unchanged: a published activity can't be edited by
-- anyone, only duplicated.
--
-- Who can do what:
--   teacher (creator)  create, edit and delete DRAFTS; add / change / remove
--                      their words; publish; share / un-share a PUBLISHED one
--                      at any time. Can't hide or unhide.
--   other teachers     read shared + published ones (and their words), run
--                      them, duplicate them (the copy is their own private draft)
--   admin              read everything (overview); hide / unhide a published
--                      activity (moderation). Nothing else: can't create, edit,
--                      publish, share, delete, duplicate or start activities.
--   anon               nothing
--
-- New columns:
--   author_name  the creator's full name, copied at creation (teachers can't
--                read each other's profiles). Never changes after that.
--   hidden_at    when an admin hid it; hidden_by: which admin. Cleared on unhide.
--                status = 'hidden' now always means "hidden by an admin".
--
-- shared:
--   - false on every new activity (also every duplicate), whatever was sent
--   - a draft is never shared (check constraint activities_draft_not_shared)
--   - only the creator changes it, and only while the activity is published
--     (or in the same update that publishes it). While hidden by an admin the
--     owner can view it but not share, un-share or unhide it.
--   - un-sharing never touches sessions: they keep their own copy of the
--     words (migration 19) and never read the activity again.
--
-- duplicate_activity: teachers only; any activity they can SEE (RLS), except a
-- hidden one (so the owner can't copy their way around a hide).
-- start_activity_session: teachers only; published AND (shared or their own).
-- It also copies author_name into the new sessions.activity_author (next to
-- activity_name), so the session and its results keep "· by <author>" even if
-- the activity is un-shared, hidden or deleted later. Sessions started before
-- this migration have it empty.
--
-- The SQL editor / service role (no signed-in user) can still change anything
-- except the edit lock, as before.
--
-- ── Check before running: no activities yet (the constraint below would
--    refuse an admin-made shared draft) ───────────────────────────────────────
-- select status, shared, count(*) from public.activities group by 1, 2;   -- no rows

begin;

-- ── Columns + constraint ─────────────────────────────────────────────────────

alter table public.activities
  add column if not exists author_name text
    constraint activities_author_name_length check (char_length(author_name) <= 200),
  add column if not exists hidden_at timestamptz,
  add column if not exists hidden_by uuid references public.profiles (id) on delete set null;

alter table public.activities drop constraint if exists activities_draft_not_shared;
alter table public.activities
  add constraint activities_draft_not_shared check (status <> 'draft' or not shared);

-- the author's name as it was when the session started (start_activity_session)
alter table public.sessions add column if not exists activity_author text;

-- ── is_teacher(): an active teacher (same shape as is_admin, migration 01) ───

create or replace function public.is_teacher()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'teacher' and is_active is not false
  );
$$;

revoke execute on function public.is_teacher() from public, anon;
grant  execute on function public.is_teacher() to authenticated;

-- ── Edit lock + ownership (replaces migration 24's function; same trigger) ──

create or replace function public.activities_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid   uuid := auth.uid();
  v_admin boolean := v_uid is not null and public.is_admin();
begin
  if tg_op = 'INSERT' then
    if new.status <> 'draft' then
      raise exception 'A new activity must start as a draft' using errcode = '23514';
    end if;
    new.published_at := null;
    new.created_at   := now();
    new.hidden_at    := null;
    new.hidden_by    := null;
    if v_uid is not null then
      new.created_by  := v_uid;
      new.shared      := false;
      new.author_name := (select nullif(btrim(p.full_name), '') from profiles p where p.id = v_uid);
    end if;
    return new;
  end if;

  -- UPDATE. created_at never changes. created_by never changes, except to
  -- null (that's ON DELETE SET NULL when the creator's profile is deleted).
  new.created_at := old.created_at;
  if new.created_by is not null then
    new.created_by := old.created_by;
  end if;
  if v_uid is not null then
    new.author_name := old.author_name;
    new.hidden_at   := old.hidden_at;   -- set below on hide / unhide
    new.hidden_by   := old.hidden_by;
  end if;

  if v_uid is not null then
    -- An admin only moderates: published ↔ hidden, nothing else
    if v_admin then
      if (new.name, new.description, new.level, new.shared)
           is distinct from (old.name, old.description, old.level, old.shared)
         or (new.status is distinct from old.status
             and not (old.status in ('published', 'hidden') and new.status in ('published', 'hidden'))) then
        raise exception 'An admin can only hide or unhide a published activity'
          using errcode = '42501';
      end if;
    -- Everyone else (RLS: only the creator gets here) can't hide or unhide
    elsif new.status is distinct from old.status
          and (old.status = 'hidden' or new.status = 'hidden') then
      raise exception 'Only an admin can hide or unhide an activity'
        using errcode = '42501';
    end if;
  end if;

  if new.shared is distinct from old.shared then
    if v_uid is not null and v_uid is distinct from old.created_by then
      raise exception 'Only the teacher who made it can share or unshare it'
        using errcode = '42501';
    end if;
    if new.status <> 'published' or old.status = 'hidden' then
      raise exception 'Only a published activity can be shared or unshared'
        using errcode = '23514';
    end if;
  end if;

  -- hidden_at / hidden_by follow the status (an admin, or the SQL editor)
  if new.status = 'hidden' and old.status <> 'hidden' then
    new.hidden_at := now();
    new.hidden_by := v_uid;
  elsif new.status <> 'hidden' and old.status = 'hidden' then
    new.hidden_at := null;
    new.hidden_by := null;
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

  -- published or hidden: only status (published ↔ hidden) and shared change
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

revoke execute on function public.activities_guard() from public, anon, authenticated;

-- ── RLS: activities ──────────────────────────────────────────────────────────
-- kept: "Admins can read activities"
--       "Teachers can read shared published activities and their own"
--       "Creators and admins can update activities" (the trigger limits admins
--        to hide / unhide and creators to everything but hide / unhide)

drop policy if exists "Signed-in users can create their own activities" on public.activities;
drop policy if exists "Teachers can create their own activities" on public.activities;
create policy "Teachers can create their own activities"
  on public.activities for insert to authenticated
  with check (created_by = auth.uid() and public.is_teacher());

drop policy if exists "Creators and admins can delete draft activities" on public.activities;
drop policy if exists "Creators can delete their draft activities" on public.activities;
create policy "Creators can delete their draft activities"
  on public.activities for delete to authenticated
  using (created_by = auth.uid() and status = 'draft');

-- ── RLS: activity_words (creator only; the migration 16 trigger keeps it to drafts)
-- kept: "Admins can read activity words"
--       "Teachers can read words of activities they can see"

drop policy if exists "Creators and admins can add activity words" on public.activity_words;
drop policy if exists "Creators can add activity words" on public.activity_words;
create policy "Creators can add activity words"
  on public.activity_words for insert to authenticated
  with check (exists (
    select 1 from public.activities a
    where a.id = activity_words.activity_id and a.created_by = auth.uid()
  ));

drop policy if exists "Creators and admins can update activity words" on public.activity_words;
drop policy if exists "Creators can update activity words" on public.activity_words;
create policy "Creators can update activity words"
  on public.activity_words for update to authenticated
  using (exists (
    select 1 from public.activities a
    where a.id = activity_words.activity_id and a.created_by = auth.uid()
  ))
  with check (exists (
    select 1 from public.activities a
    where a.id = activity_words.activity_id and a.created_by = auth.uid()
  ));

drop policy if exists "Creators and admins can delete activity words" on public.activity_words;
drop policy if exists "Creators can delete activity words" on public.activity_words;
create policy "Creators can delete activity words"
  on public.activity_words for delete to authenticated
  using (exists (
    select 1 from public.activities a
    where a.id = activity_words.activity_id and a.created_by = auth.uid()
  ));

-- ── duplicate_activity: teachers only, not a hidden one ──────────────────────
-- SECURITY INVOKER: RLS decides what the caller can see. The copy's
-- created_by, author_name and shared (false) are set by the trigger.

create or replace function public.duplicate_activity(p_activity uuid)
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_new uuid;
begin
  if not public.is_teacher() then
    raise exception 'Only a teacher can duplicate an activity' using errcode = '42501';
  end if;

  if exists (select 1 from activities where id = p_activity and status = 'hidden') then
    raise exception 'A hidden activity can''t be duplicated' using errcode = '42501';
  end if;

  insert into activities (name, description, level)
  select left(btrim(a.name), 93) || ' (copy)', a.description, a.level
  from activities a
  where a.id = p_activity
  returning id into v_new;

  if v_new is null then
    raise exception 'No such activity' using errcode = 'P0002';
  end if;

  insert into activity_words (activity_id, position, word, duration_seconds)
  select v_new, w.position, w.word, w.duration_seconds
  from activity_words w
  where w.activity_id = p_activity;

  return v_new;
end;
$$;

revoke execute on function public.duplicate_activity(uuid) from public, anon;
grant  execute on function public.duplicate_activity(uuid) to authenticated;

-- ── start_activity_session: teachers only ────────────────────────────────────
-- Same as migration 24 plus the is_teacher() check and activity_author.

create or replace function public.start_activity_session(p_session uuid, p_activity uuid)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  s     sessions%rowtype;
  v_name    text;
  v_status  text;
  v_shared  boolean;
  v_creator uuid;
  v_author  text;
  n int;
begin
  if v_uid is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  if not public.is_teacher() then
    raise exception 'Only a teacher can start an activity' using errcode = '42501';
  end if;

  -- Lock the session: two taps can't both copy the words
  select * into s from sessions where id = p_session for update;
  if not found or s.teacher_id is distinct from v_uid then
    raise exception 'Not your session' using errcode = '42501';
  end if;

  -- A retry of a call that already worked
  if s.activity_id = p_activity
     and exists (select 1 from session_words where session_id = p_session) then
    return (select count(*)::int from session_words where session_id = p_session);
  end if;

  -- FOR SHARE: the activity can't be hidden or un-shared halfway through the copy
  select name, status, shared, created_by, author_name
    into v_name, v_status, v_shared, v_creator, v_author
    from activities where id = p_activity for share;
  if not found or v_status <> 'published'
     or not (v_shared or v_creator is not distinct from v_uid) then
    raise exception 'Only a published activity can be started' using errcode = 'P0001';
  end if;

  if s.status <> 'pending' then
    raise exception 'The session has already started' using errcode = 'P0001';
  end if;
  if exists (select 1 from session_words where session_id = p_session) then
    raise exception 'The session already has words' using errcode = 'P0001';
  end if;

  insert into session_words (session_id, word, order_index, duration_seconds)
  select p_session,
         w.word,
         (row_number() over (order by w.position) - 1)::int,
         w.duration_seconds
  from activity_words w
  where w.activity_id = p_activity;
  get diagnostics n = row_count;

  update sessions
     set type            = 'activity',
         activity_id     = p_activity,
         activity_name   = v_name,
         activity_author = v_author,
         current_index   = 0
   where id = p_session;

  return n;
end;
$$;

revoke execute on function public.start_activity_session(uuid, uuid) from public, anon;
grant  execute on function public.start_activity_session(uuid, uuid) to authenticated;

commit;

-- ── Check after running ──────────────────────────────────────────────────────
-- select column_name from information_schema.columns
--  where (table_name = 'activities' and column_name in ('author_name', 'hidden_at', 'hidden_by'))
--     or (table_name = 'sessions' and column_name = 'activity_author');                  -- 4 rows
-- select tablename, policyname, cmd from pg_policies
--  where tablename in ('activities', 'activity_words') order by 1, 2;
--   → activities: Admins can read / Creators and admins can update /
--     Creators can delete their draft / Teachers can create their own /
--     Teachers can read shared published activities and their own   (5)
--     activity_words: Admins can read / Creators can add / Creators can delete /
--     Creators can update / Teachers can read words of activities they can see (5)
-- select public.duplicate_activity(gen_random_uuid());   -- error "Only a teacher can duplicate an activity"
-- Then run supabase/tests/phase1_activities_checks.sql (all PASS).
--
-- ── ROLLBACK (puts back migration 24's rules) ────────────────────────────────
-- Re-run 20261111120900_teacher_activities.sql (it recreates activities_guard,
-- the policies it names, duplicate_activity and start_activity_session), then:
-- drop policy if exists "Teachers can create their own activities" on public.activities;
-- drop policy if exists "Creators can delete their draft activities" on public.activities;
-- drop policy if exists "Creators can add activity words" on public.activity_words;
-- drop policy if exists "Creators can update activity words" on public.activity_words;
-- drop policy if exists "Creators can delete activity words" on public.activity_words;
-- alter table public.activities drop constraint if exists activities_draft_not_shared;
-- alter table public.activities drop column if exists hidden_by,
--   drop column if exists hidden_at, drop column if exists author_name;
-- alter table public.sessions drop column if exists activity_author;
-- drop function if exists public.is_teacher();
