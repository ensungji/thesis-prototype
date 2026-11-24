-- 27 · answer_attempts: which device each try came from, and whether it was late
-- Reports (PDF / CSV). ADDITIVE ONLY: two new nullable columns and an index.
-- Nothing is dropped, no type changes, no rows deleted.
--
-- Until now the device and the "late" flag of a voice answer were only in
-- system_logs (event 'answer_graded', which teachers can't read), so the
-- reports couldn't show "device used" or "late answer".
--
--   device_id   the device that sent this try (grade-answer, from ?device=).
--               ON DELETE SET NULL: removing a device never removes a try.
--   late        true = the device answered a word it was no longer showing
--               (AUDIT 4.1; grade-answer then grades it as 'review').
--               null = not recorded (tries saved before this migration that
--               the backfill below couldn't match).
--
-- Rights: unchanged. Teachers / admins only SELECT (migration 20); only the
-- service role (grade-answer) writes.
--
-- Part B fills the two new columns on EXISTING tries from the matching
-- 'answer_graded' log rows (same session word, student and try number). It
-- only writes rows where device_id is still null, never changes any other
-- column, and is safe to run more than once.
--
-- ORDER: run this BEFORE deploying the new grade-answer (it writes the two
-- columns; the old one doesn't, and the new one also still works without
-- them, see saveTry).

begin;

-- ── Part A: columns ──────────────────────────────────────────────────────────
alter table public.answer_attempts
  add column if not exists device_id uuid references public.devices (id) on delete set null,
  add column if not exists late      boolean;

-- the ON DELETE SET NULL looks tries up by device_id
create index if not exists answer_attempts_device_id_idx
  on public.answer_attempts (device_id) where device_id is not null;

-- ── Part B: backfill from the logs (new columns only) ────────────────────────
update public.answer_attempts aa
   set device_id = l.device_id,
       late      = case l.meta->>'late' when 'true' then true when 'false' then false end
  from (
    select distinct on (meta->>'session_word_id', meta->>'student_id', meta->>'attempt_no')
           device_id, meta
      from public.system_logs
     where event = 'answer_graded'
       and device_id is not null
       and meta->>'attempt_no' ~ '^[0-9]+$'
     order by meta->>'session_word_id', meta->>'student_id', meta->>'attempt_no', created_at desc
  ) l
 where aa.device_id is null
   and l.meta->>'session_word_id' = aa.session_word_id::text
   and l.meta->>'student_id'      = aa.student_id::text
   and (l.meta->>'attempt_no')::int = aa.attempt_no
   and exists (select 1 from public.devices d where d.id = l.device_id);

commit;

-- ── Check after running ──────────────────────────────────────────────────────
-- select column_name, data_type, is_nullable from information_schema.columns
-- where table_schema = 'public' and table_name = 'answer_attempts'
--   and column_name in ('device_id', 'late');                 -- 2 rows, uuid / boolean, YES
-- select count(*) as tries, count(device_id) as with_device, count(late) as with_late
-- from public.answer_attempts;                                -- with_device ≈ tries
--
-- ── ROLLBACK ─────────────────────────────────────────────────────────────────
-- (only if needed; deploy the old grade-answer first)
-- drop index if exists public.answer_attempts_device_id_idx;
-- alter table public.answer_attempts drop column if exists late, drop column if exists device_id;
