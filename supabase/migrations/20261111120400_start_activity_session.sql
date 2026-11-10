-- 19 · start_activity_session(p_session, p_activity): copy an activity's words into a session
-- Phase 1, part 2.
--
-- One call, one transaction: either every word is copied and the session is
-- marked as an activity session, or nothing changes.
--
--   session_words   one row per activity word: word, duration_seconds, and
--                   order_index = 0, 1, 2, ... in the activity's position order
--                   (gaps in the positions don't matter)
--   sessions        type = 'activity', activity_id, activity_name (copied),
--                   current_index = 0. status is NOT changed: the app starts
--                   the session as it does now.
-- Returns the number of words in the session.
--
-- Refused (nothing changes) when:
--   - the caller isn't the session's teacher        "Not your session"
--   - the activity isn't published (draft, hidden,
--     or doesn't exist)                              "Only a published activity can be started"
--   - the session isn't pending                      "The session has already started"
--   - the session already has words                  "The session already has words"
-- Calling it again for the same session and activity (an app retry after a
-- dropped connection) does nothing and returns the word count again.
--
-- After this, the session's words are its own copy: hiding, duplicating or
-- deleting the activity never changes them, nor the answers or recordings.
--
-- SECURITY DEFINER (it checks the caller itself), so it works the same
-- whatever the session_words policies say. EXECUTE only for signed-in users.

create or replace function public.start_activity_session(p_session uuid, p_activity uuid)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  s     sessions%rowtype;
  v_name   text;
  v_status text;
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
  select name, status into v_name, v_status from activities where id = p_activity for share;
  if not found or v_status <> 'published' then
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

-- ── Check after running (the SQL editor isn't signed in, so expect the error
--    "Not signed in") ─────────────────────────────────────────────────────────
-- select public.start_activity_session(gen_random_uuid(), gen_random_uuid());
--
-- ── ROLLBACK ─────────────────────────────────────────────────────────────────
-- drop function if exists public.start_activity_session(uuid, uuid);
