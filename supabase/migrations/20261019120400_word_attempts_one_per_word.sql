-- 04 · One answer per student per word
-- AUDIT 4.4.
--
-- A plain (not partial) unique index: the app's hand grade and grade-answer
-- both rely on ON CONFLICT (session_word_id, student_id), and PostgREST can't
-- target a partial index. Rows with session_word_id = null never clash
-- (NULLs are distinct), so old answers without a word id are unaffected.
--
-- Existing duplicates are removed first. Per student + word the one kept is:
--   1. the teacher's hand grade, if there is one (it beats a voice answer,
--      same rule as grade-answer)
--   2. otherwise the NEWEST answer (by attempted_at, then id)
-- Rows without a student_id are left alone. The removed rows are copied to
-- audit_backup.word_attempts_dupes_20261019 (a schema the API doesn't expose),
-- and letter_attempts that pointed at a removed row are moved to the kept one.
-- Their recordings stay in the "answers" bucket.
--
-- Preview — how many rows will be removed:
--   select count(*) from (
--     select row_number() over (partition by session_word_id, student_id
--                               order by (graded_by = 'teacher') desc nulls last,
--                                        attempted_at desc nulls last, id desc) as rn
--     from public.word_attempts
--     where session_word_id is not null and student_id is not null
--   ) t where rn > 1;

begin;

create schema if not exists audit_backup;
revoke all on schema audit_backup from anon, authenticated;

create temporary table dupes on commit drop as
select id, keep_id
from (
  select id,
         first_value(id) over w as keep_id,
         row_number()    over w as rn
  from public.word_attempts
  where session_word_id is not null and student_id is not null
  -- "nulls last": a row with no graded_by must not rank above a teacher grade
  window w as (partition by session_word_id, student_id
               order by (graded_by = 'teacher') desc nulls last,
                        attempted_at desc nulls last, id desc)
) ranked
where rn > 1;

create table if not exists audit_backup.word_attempts_dupes_20261019 as
select wa.* from public.word_attempts wa where false;

insert into audit_backup.word_attempts_dupes_20261019
select wa.* from public.word_attempts wa join dupes d on d.id = wa.id;

update public.letter_attempts la
set word_attempt_id = d.keep_id
from dupes d
where la.word_attempt_id = d.id;

delete from public.word_attempts wa
using dupes d
where wa.id = d.id;

create unique index if not exists word_attempts_one_per_word
  on public.word_attempts (session_word_id, student_id);

commit;

-- ── ROLLBACK ─────────────────────────────────────────────────────────────────
-- drop index if exists public.word_attempts_one_per_word;
-- insert into public.word_attempts
--   select * from audit_backup.word_attempts_dupes_20261019 on conflict (id) do nothing;
-- (letter_attempts that were moved stay on the kept row.)
