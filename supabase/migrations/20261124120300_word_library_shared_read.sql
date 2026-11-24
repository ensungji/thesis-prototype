-- 29 · Shared Word Bank: every active teacher (and admins) can READ all words
-- Part 6. ADDITIVE ONLY: one new SELECT policy. The existing word_library
-- policies (migration 09) are not changed or dropped:
--   "Teachers can read own and shared words"   select  own + teacher_id null
--   "Teachers can insert own words"            insert  own only
--   "Teachers can update own words"            update  own only
--   "Teachers can delete own words"            delete  own only
-- Policies of the same command are OR-ed, so reading becomes:
--   own + teacher_id null (as before)  OR  is_teacher()  OR  is_admin()
-- Writing stays owner-only: a teacher still can't change or delete another
-- teacher's words.
--
-- is_teacher() (migration 25) = role 'teacher' and is_active not false, so a
-- deactivated teacher or one still waiting for approval (migration 28) gets
-- nothing extra. is_admin() (migration 01) = active admin.
--
-- The current app filters every word_library query by teacher_id, so nothing
-- changes on screen until the Part 6 app update: safe to run first.
--
-- Safe to run more than once (creates the policy only if it isn't there).

begin;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'word_library'
      and policyname = 'Teachers and admins can read all words'
  ) then
    create policy "Teachers and admins can read all words"
      on public.word_library for select to authenticated
      using (public.is_teacher() or public.is_admin());
  end if;
end $$;

commit;

-- ── Check after running ──────────────────────────────────────────────────────
-- select policyname, cmd, qual, with_check from pg_policies
-- where schemaname = 'public' and tablename = 'word_library' order by cmd, policyname;
--   → 5 rows: DELETE own, INSERT own, SELECT "Teachers and admins can read
--     all words" (is_teacher() OR is_admin()), SELECT "Teachers can read own
--     and shared words", UPDATE own
--
-- ── ROLLBACK ─────────────────────────────────────────────────────────────────
-- drop policy if exists "Teachers and admins can read all words" on public.word_library;
