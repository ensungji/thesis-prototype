-- 26 · Maintenance mode
--
-- app_settings: one row (id = true) with
--   maintenance             on / off
--   maintenance_message     optional text for the teachers' banner (≤ 300)
--   maintenance_started_at  when it was turned on (empty while off)
--   maintenance_set_by      who last turned it on or off
-- Every signed-in user can read it; only an admin can change it. Turning it
-- on or off writes a system_logs row (maintenance_on / maintenance_off).
-- The table is added to Realtime so open apps see the change at once.
--
-- While it's on, for a signed-in user who isn't an admin, the database refuses
-- (SQLSTATE DT002, "Maintenance mode is on. …"):
--   sessions         creating one (INSERT), and starting a pending one
--                    (status pending → in_progress / paused)
--   start_activity_session
--   activities       any insert / update / delete (create, edit, publish,
--                    share, duplicate, delete draft)
--   activity_words   any insert / update / delete
-- Still allowed: everything a session that already started needs (Next =
-- current_index, pause, resume, finish, sending words, grading, review),
-- reading anything, students, word bank, device pairing. Admins and the
-- service role (grade-answer, register-device) are never blocked, so a device
-- answer is still graded. The SQL editor isn't blocked either.
--
-- Enforced by triggers (named a_maintenance_guard so they run before the
-- other BEFORE triggers on the same table), so an old app build can't get
-- around it.
--
-- Needs migration 25 (start_activity_session is recreated from there).

begin;

-- ── Table ────────────────────────────────────────────────────────────────────

create table if not exists public.app_settings (
  id                     boolean primary key default true
                         constraint app_settings_single_row check (id),
  maintenance            boolean not null default false,
  maintenance_message    text
                         constraint app_settings_message_length check (char_length(maintenance_message) <= 300),
  maintenance_started_at timestamptz,
  maintenance_set_by     uuid references public.profiles (id) on delete set null,
  updated_at             timestamptz not null default now()
);

insert into public.app_settings (id) values (true) on conflict (id) do nothing;

alter table public.app_settings enable row level security;
revoke all on public.app_settings from anon;
revoke insert, delete, truncate on public.app_settings from authenticated;

drop policy if exists "Signed-in users can read app settings" on public.app_settings;
create policy "Signed-in users can read app settings"
  on public.app_settings for select to authenticated
  using (true);

drop policy if exists "Admins can update app settings" on public.app_settings;
create policy "Admins can update app settings"
  on public.app_settings for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- ── started_at / set_by / updated_at are set here, not by the app ────────────

create or replace function public.app_settings_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.id := old.id;
  new.updated_at := now();
  new.maintenance_message := nullif(btrim(new.maintenance_message), '');
  if new.maintenance is distinct from old.maintenance then
    new.maintenance_set_by     := auth.uid();
    new.maintenance_started_at := case when new.maintenance then now() end;
  else
    new.maintenance_set_by     := old.maintenance_set_by;
    new.maintenance_started_at := old.maintenance_started_at;
  end if;
  return new;
end;
$$;

drop trigger if exists app_settings_guard on public.app_settings;
create trigger app_settings_guard
  before update on public.app_settings
  for each row execute function public.app_settings_guard();

-- ── Log on / off to system_logs (a failed log never blocks the switch) ───────

create or replace function public.app_settings_log()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text;
begin
  if new.maintenance is not distinct from old.maintenance then
    return null;
  end if;
  begin
    select nullif(btrim(full_name), '') into v_name from profiles where id = auth.uid();
    insert into system_logs (level, source, event, message, user_id, meta)
    values (
      case when new.maintenance then 'warn' else 'info' end,
      'server',
      case when new.maintenance then 'maintenance_on' else 'maintenance_off' end,
      left(case when new.maintenance
                then 'Maintenance mode turned on' || coalesce(' by ' || v_name, '')
                     || coalesce(': ' || new.maintenance_message, '')
                else 'Maintenance mode turned off' || coalesce(' by ' || v_name, '')
           end, 500),
      auth.uid(),
      jsonb_build_object('message', new.maintenance_message,
                         'started_at', coalesce(new.maintenance_started_at, old.maintenance_started_at))
    );
  exception when others then
    raise warning 'maintenance log not written: %', sqlerrm;
  end;
  return null;
end;
$$;

drop trigger if exists app_settings_log on public.app_settings;
create trigger app_settings_log
  after update on public.app_settings
  for each row execute function public.app_settings_log();

-- ── Helpers ──────────────────────────────────────────────────────────────────

create or replace function public.maintenance_on()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select maintenance from public.app_settings where id), false);
$$;

-- true = maintenance is on and the caller is a signed-in non-admin
create or replace function public.maintenance_blocks_me()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select auth.uid() is not null and public.maintenance_on() and not public.is_admin();
$$;

revoke execute on function public.maintenance_on(), public.maintenance_blocks_me() from public, anon;
grant  execute on function public.maintenance_on(), public.maintenance_blocks_me() to authenticated;

-- ── The guard (one function for every table) ─────────────────────────────────

create or replace function public.maintenance_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.maintenance_blocks_me() then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  if tg_table_name = 'sessions' then
    if tg_op = 'INSERT' then
      raise exception 'Maintenance mode is on. New sessions can''t be created until it ends.'
        using errcode = 'DT002';
    end if;
    -- UPDATE: only starting a pending session is refused
    if old.status = 'pending' and new.status in ('in_progress', 'paused') then
      raise exception 'Maintenance mode is on. Sessions can''t be started until it ends.'
        using errcode = 'DT002';
    end if;
    return new;
  end if;

  -- activities, activity_words: every write
  raise exception 'Maintenance mode is on. Activities can''t be changed until it ends.'
    using errcode = 'DT002';
end;
$$;

revoke execute on function public.app_settings_guard(), public.app_settings_log(), public.maintenance_guard()
  from public, anon, authenticated;

drop trigger if exists a_maintenance_guard on public.sessions;
create trigger a_maintenance_guard
  before insert or update on public.sessions
  for each row execute function public.maintenance_guard();

drop trigger if exists a_maintenance_guard on public.activities;
create trigger a_maintenance_guard
  before insert or update or delete on public.activities
  for each row execute function public.maintenance_guard();

drop trigger if exists a_maintenance_guard on public.activity_words;
create trigger a_maintenance_guard
  before insert or update or delete on public.activity_words
  for each row execute function public.maintenance_guard();

-- ── start_activity_session: + maintenance (otherwise as migration 25) ────────

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
  if public.maintenance_blocks_me() then
    raise exception 'Maintenance mode is on. Sessions can''t be started until it ends.'
      using errcode = 'DT002';
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

-- ── Realtime (skipped where there's no supabase_realtime publication) ────────

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables
                     where pubname = 'supabase_realtime' and schemaname = 'public'
                       and tablename = 'app_settings') then
    alter publication supabase_realtime add table public.app_settings;
  end if;
end $$;

commit;

-- ── Check after running ──────────────────────────────────────────────────────
-- select * from public.app_settings;                         -- 1 row, maintenance false
-- select tgrelid::regclass, tgname from pg_trigger
--  where tgname in ('a_maintenance_guard', 'app_settings_guard', 'app_settings_log') order by 1;
--   → activities, activity_words, app_settings ×2, sessions   (5 rows)
-- select public.maintenance_on();                            -- false
-- Then run supabase/tests/phase1_activities_checks.sql (all PASS).
--
-- ── Emergency off (SQL editor, if no admin can sign in) ──────────────────────
-- update public.app_settings set maintenance = false;
--
-- ── ROLLBACK ─────────────────────────────────────────────────────────────────
-- begin;
-- drop trigger if exists a_maintenance_guard on public.sessions;
-- drop trigger if exists a_maintenance_guard on public.activities;
-- drop trigger if exists a_maintenance_guard on public.activity_words;
-- drop function if exists public.maintenance_guard();
-- drop function if exists public.maintenance_blocks_me();
-- drop function if exists public.maintenance_on();
-- -- start_activity_session: re-run its section from 20261112120100_teacher_owned_activities.sql
-- drop table if exists public.app_settings;   -- drops its triggers and policies
-- drop function if exists public.app_settings_log();
-- drop function if exists public.app_settings_guard();
-- commit;
