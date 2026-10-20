-- 09 · Word bank: shared words are read-only
-- Policy review finding 6.
--
-- The single ALL policy used (teacher_id = auth.uid() OR teacher_id IS NULL)
-- as USING for every command, so any teacher could UPDATE or DELETE the
-- shared words (teacher_id null). Split per command:
--   read           own words + shared words
--   insert/update  own words only (the new row must be yours too)
--   delete         own words only
-- The app only lists and deletes the teacher's own words in the word bank
-- screen, and reads own + shared words in add-word, so nothing in it changes.

drop policy if exists "Teachers can manage own word library" on public.word_library;

create policy "Teachers can read own and shared words"
  on public.word_library for select to authenticated
  using (teacher_id = auth.uid() or teacher_id is null);

create policy "Teachers can insert own words"
  on public.word_library for insert to authenticated
  with check (teacher_id = auth.uid());

create policy "Teachers can update own words"
  on public.word_library for update to authenticated
  using (teacher_id = auth.uid())
  with check (teacher_id = auth.uid());

create policy "Teachers can delete own words"
  on public.word_library for delete to authenticated
  using (teacher_id = auth.uid());

-- ── ROLLBACK ─────────────────────────────────────────────────────────────────
-- drop policy if exists "Teachers can read own and shared words" on public.word_library;
-- drop policy if exists "Teachers can insert own words" on public.word_library;
-- drop policy if exists "Teachers can update own words" on public.word_library;
-- drop policy if exists "Teachers can delete own words" on public.word_library;
-- create policy "Teachers can manage own word library" on public.word_library
--   for all to public
--   using ((auth.uid() = teacher_id) or (teacher_id is null))
--   with check (auth.uid() = teacher_id);
