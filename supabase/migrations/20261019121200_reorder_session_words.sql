-- 12 · Save a shuffled word order in one step
-- AUDIT 4.6. Used by the Shuffle button in app/(teacher)/sessions/[id].tsx.
--
-- One UPDATE: either every position is saved or none is.
-- p_ids is the full list of the session's word ids in the new order;
-- order_index becomes 0, 1, 2, ... in that order.
--
-- No unique (session_id, word) rule is added: a Live session's
-- "Re-send Anyway" inserts a second session_words row for the same word.
--
-- SECURITY INVOKER: the existing "Teachers can update own session words"
-- policy decides who may do this.

create or replace function public.reorder_session_words(p_session uuid, p_ids uuid[])
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  n int;
begin
  with ord as (
    select t.id, (t.pos - 1)::int as idx
    from unnest(p_ids) with ordinality as t(id, pos)
  )
  update session_words sw
     set order_index = ord.idx
    from ord
   where sw.id = ord.id
     and sw.session_id = p_session;

  get diagnostics n = row_count;
  if n <> coalesce(array_length(p_ids, 1), 0) then
    -- some id isn't in this session (or isn't yours): undo everything
    raise exception 'reorder: % of % words updated', n, coalesce(array_length(p_ids, 1), 0)
      using errcode = 'P0001';
  end if;
end;
$$;

revoke execute on function public.reorder_session_words(uuid, uuid[]) from public, anon;
grant  execute on function public.reorder_session_words(uuid, uuid[]) to authenticated;

-- ── ROLLBACK ─────────────────────────────────────────────────────────────────
-- drop function if exists public.reorder_session_words(uuid, uuid[]);
