-- 18 · Sessions: a third type, 'activity'
-- Phase 1, part 2.
--
-- sessions.type keeps its two existing values and gets one more:
--   manual     Live Session      (the app tries 'live_session' first, the check
--   word_list  Timed Sequence     refuses it, the app retries with these two)
--   activity   Activity          (new: words copied from a published activity)
-- 'live_session' / 'timed_sequence' stay refused on purpose: the app's
-- fallback in sessions/new.tsx depends on that error.
--
-- New columns:
--   activity_id    the activity the words came from. ON DELETE SET NULL, so
--                  deleting an activity never deletes or blocks a session.
--   activity_name  the activity's name, copied when the session starts
--                  (migration 19), so the session keeps it even if the
--                  activity is hidden or deleted later.
--   current_index  which word the session is on (0 = first). Default 0.
--
-- Existing rows: type unchanged (32 manual, 10 word_list), activity_id and
-- activity_name empty, current_index 0.
--
-- Note: if an activity is ever deleted while sessions point to it (only the
-- SQL editor can do that; admins can only delete drafts, which no session
-- uses), setting activity_id to null is an UPDATE on those sessions, so the
-- existing sessions_updated_at and trg_log_session_change triggers run for them.

begin;

alter table public.sessions drop constraint sessions_type_check;
alter table public.sessions
  add constraint sessions_type_check
  check (type = any (array['manual', 'word_list', 'activity']));

alter table public.sessions
  add column activity_id   uuid references public.activities (id) on delete set null,
  add column activity_name text,
  add column current_index int not null default 0
    constraint sessions_current_index_check check (current_index >= 0);

-- the foreign key's ON DELETE SET NULL looks sessions up by activity_id
create index sessions_activity_id_idx on public.sessions (activity_id)
  where activity_id is not null;

commit;

-- ── Check after running ──────────────────────────────────────────────────────
-- select pg_get_constraintdef(oid) from pg_constraint where conname = 'sessions_type_check';
--   → CHECK ((type = ANY (ARRAY['manual'::text, 'word_list'::text, 'activity'::text])))
-- select type, count(*), count(activity_id), min(current_index), max(current_index)
-- from public.sessions group by type;
--   → manual 32 / word_list 10 (or more), activity_id count 0, current_index 0 / 0
--
-- ── ROLLBACK (only while no session has type 'activity') ────────────────────
-- begin;
-- drop index if exists public.sessions_activity_id_idx;
-- alter table public.sessions drop column if exists current_index,
--                             drop column if exists activity_name,
--                             drop column if exists activity_id;
-- alter table public.sessions drop constraint sessions_type_check;
-- alter table public.sessions add constraint sessions_type_check
--   check (type = any (array['manual', 'word_list']));
-- commit;
