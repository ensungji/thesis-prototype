-- 17 · duplicate_activity(id): copy an activity into a new draft
-- Phase 1, part 1.
--
-- A published activity can't be edited (migration 16), so an admin changes
-- one by duplicating it, editing the copy, publishing the copy and hiding the
-- old one. Works on any status (draft, published, hidden).
--
-- The copy:
--   name         "<name> (copy)"  (the original is shortened if needed to stay
--                 within 100 characters)
--   description, level, and every word with its position and hold time
--   status       draft, published_at empty
--   created_by   the admin who duplicated it (set by the activities trigger)
-- Returns the new activity's id.
--
-- Admin only. SECURITY INVOKER: the admin policies from migration 16 apply as
-- well, and nothing in it bypasses RLS.

create or replace function public.duplicate_activity(p_activity uuid)
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_new uuid;
begin
  if not public.is_admin() then
    raise exception 'Only an admin can duplicate an activity' using errcode = '42501';
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

-- ── Check after running (as is: the SQL editor isn't an admin, so expect
--    the error "Only an admin can duplicate an activity") ───────────────────
-- select public.duplicate_activity(gen_random_uuid());
--
-- ── ROLLBACK ─────────────────────────────────────────────────────────────────
-- drop function if exists public.duplicate_activity(uuid);
