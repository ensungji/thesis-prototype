-- 24 · Teachers can make activities too
--
--   shared = true   made by an admin: every teacher sees it once published (as before)
--   shared = false  made by a teacher: only that teacher and admins see it
--
-- Who can do what (RLS):
--   read               admins: everything
--                      teachers: shared + published, and all of their own
--                      (draft, published, hidden)
--   create             any signed-in user; created_by is always the caller
--                      (the trigger sets it, as before)
--   edit / publish /   the creator or an admin. The edit lock (migration 16) is
--   hide / un-hide     unchanged: a published activity stays locked for everyone.
--   delete             the creator or an admin, drafts only
--   words              read with the activity; added / changed / removed by the
--                      creator or an admin (drafts only, migration 16 trigger)
--
-- shared (trigger, holds for everyone signed in):
--   on insert   true when the creator is an admin, false otherwise (whatever
--               was sent). The SQL editor / service role keep what they send.
--   on update   only an admin can change it (at any status: it isn't part of
--               the edit lock, so an admin can share a teacher's activity).
--
-- duplicate_activity: anyone signed in can copy an activity they can SEE
-- (SECURITY INVOKER, so RLS decides). The copy is a draft owned by the caller,
-- shared only when an admin made the copy (the trigger above).
--
-- start_activity_session: the activity must be published AND shared or the
-- caller's own. Anything else gets the same "Only a published activity can be
-- started", so another teacher's private activity looks like it doesn't exist.
-- (An admin starting a session follows the same rule: shared or their own.)
--
-- Existing rows become shared = true (they were all made by the admin). The
-- column is added with default true, then the default is set to false, so the
-- edit-lock trigger never fires and a re-run changes nothing.
--
-- ── Check before running: every existing activity was made by an admin
--    (role admin, or empty if that profile was deleted) ─────────────────────
-- select p.role, count(*) from public.activities a
--   left join public.profiles p on p.id = a.created_by group by 1;

begin;

-- ── Column ───────────────────────────────────────────────────────────────────

alter table public.activities add column if not exists shared boolean not null default true;
alter table public.activities alter column shared set default false;

-- ── Edit lock + shared (replaces migration 16's function; same trigger) ─────

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
      new.shared := public.is_admin();
    end if;
    return new;
  end if;

  -- UPDATE. created_at never changes. created_by never changes, except to
  -- null (that's ON DELETE SET NULL when the creator's profile is deleted).
  new.created_at := old.created_at;
  if new.created_by is not null then
    new.created_by := old.created_by;
  end if;

  if new.shared is distinct from old.shared
     and auth.uid() is not null and not public.is_admin() then
    raise exception 'Only an admin can change whether an activity is shared'
      using errcode = '42501';
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

revoke execute on function public.activities_guard() from public, anon, authenticated;

-- ── RLS: activities ──────────────────────────────────────────────────────────
-- kept: "Admins can read activities"

drop policy if exists "Teachers can read published activities" on public.activities;
drop policy if exists "Teachers can read shared published activities and their own" on public.activities;
create policy "Teachers can read shared published activities and their own"
  on public.activities for select to authenticated
  using (created_by = auth.uid() or (shared and status = 'published'));

drop policy if exists "Admins can create activities" on public.activities;
drop policy if exists "Signed-in users can create their own activities" on public.activities;
create policy "Signed-in users can create their own activities"
  on public.activities for insert to authenticated
  with check (created_by = auth.uid());

drop policy if exists "Admins can update activities" on public.activities;
drop policy if exists "Creators and admins can update activities" on public.activities;
create policy "Creators and admins can update activities"
  on public.activities for update to authenticated
  using (public.is_admin() or created_by = auth.uid())
  with check (public.is_admin() or created_by = auth.uid());

drop policy if exists "Admins can delete draft activities" on public.activities;
drop policy if exists "Creators and admins can delete draft activities" on public.activities;
create policy "Creators and admins can delete draft activities"
  on public.activities for delete to authenticated
  using ((public.is_admin() or created_by = auth.uid()) and status = 'draft');

-- ── RLS: activity_words ──────────────────────────────────────────────────────
-- kept: "Admins can read activity words"

drop policy if exists "Teachers can read published activity words" on public.activity_words;
drop policy if exists "Teachers can read words of activities they can see" on public.activity_words;
create policy "Teachers can read words of activities they can see"
  on public.activity_words for select to authenticated
  using (exists (
    select 1 from public.activities a
    where a.id = activity_words.activity_id
      and (a.created_by = auth.uid() or (a.shared and a.status = 'published'))
  ));

drop policy if exists "Admins can add activity words" on public.activity_words;
drop policy if exists "Creators and admins can add activity words" on public.activity_words;
create policy "Creators and admins can add activity words"
  on public.activity_words for insert to authenticated
  with check (public.is_admin() or exists (
    select 1 from public.activities a
    where a.id = activity_words.activity_id and a.created_by = auth.uid()
  ));

drop policy if exists "Admins can update activity words" on public.activity_words;
drop policy if exists "Creators and admins can update activity words" on public.activity_words;
create policy "Creators and admins can update activity words"
  on public.activity_words for update to authenticated
  using (public.is_admin() or exists (
    select 1 from public.activities a
    where a.id = activity_words.activity_id and a.created_by = auth.uid()
  ))
  with check (public.is_admin() or exists (
    select 1 from public.activities a
    where a.id = activity_words.activity_id and a.created_by = auth.uid()
  ));

drop policy if exists "Admins can delete activity words" on public.activity_words;
drop policy if exists "Creators and admins can delete activity words" on public.activity_words;
create policy "Creators and admins can delete activity words"
  on public.activity_words for delete to authenticated
  using (public.is_admin() or exists (
    select 1 from public.activities a
    where a.id = activity_words.activity_id and a.created_by = auth.uid()
  ));

-- ── duplicate_activity: no admin-only check; RLS decides ─────────────────────
-- The copy's created_by (the caller) and shared (true only for an admin) are
-- set by the activities trigger.

create or replace function public.duplicate_activity(p_activity uuid)
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_new uuid;
begin
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

-- ── start_activity_session: + visible to the caller ──────────────────────────
-- Same as migration 19 except the activity check.

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
  n int;
begin
  if v_uid is null then
    raise exception 'Not signed in' using errcode = '42501';
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

  -- FOR SHARE: the activity can't be hidden halfway through the copy
  select name, status, shared, created_by into v_name, v_status, v_shared, v_creator
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
     set type          = 'activity',
         activity_id   = p_activity,
         activity_name = v_name,
         current_index = 0
   where id = p_session;

  return n;
end;
$$;

revoke execute on function public.start_activity_session(uuid, uuid) from public, anon;
grant  execute on function public.start_activity_session(uuid, uuid) to authenticated;

commit;

-- ── Check after running ──────────────────────────────────────────────────────
-- select shared, count(*) from public.activities group by 1;        -- all true
-- select tablename, policyname, cmd from pg_policies
-- where tablename in ('activities', 'activity_words') order by 1, 2; -- 10 rows, names above
-- select public.duplicate_activity(gen_random_uuid());               -- error "No such activity"
-- Then run supabase/tests/phase1_activities_checks.sql (all PASS).
--
-- ── ROLLBACK (puts back migrations 16, 17 and 19 as they were) ──────────────
-- Re-run 20261111120200_duplicate_activity.sql and
-- 20261111120400_start_activity_session.sql, the activities_guard function and
-- the RLS section of 20261111120100_activities.sql (drop the new policy names
-- first), then:
-- alter table public.activities drop column shared;
-- (Only before any teacher has made an activity: after that, dropping the
-- column makes their activities visible to every teacher once published.)
