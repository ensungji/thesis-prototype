-- 14 · Each word's hold time is stored on the server
-- Bug B-02 (a word added with 30 s showed 10 s in the Sequence tab).
--
-- The app saves each word's time in session_words.duration_seconds and runs
-- the Timed Sequence with that value. If the column were missing, the app
-- silently fell back to a copy kept on one phone, so another screen (or
-- another phone) showed and ran the 10 s default. This makes sure the column
-- is there, defaults to 10 s, and can never hold a time outside 5–60 s (the
-- solenoid safety limit the app already enforces).
--
-- Safe to run if the column already exists. Existing times are kept; a time
-- outside 5–60 s (there shouldn't be any) is moved to the nearest limit.
-- Rows with no time stay empty: the app then uses the phone's copy, or 10 s.

begin;

alter table public.session_words add column if not exists duration_seconds int;
alter table public.session_words alter column duration_seconds set default 10;

update public.session_words
   set duration_seconds = least(60, greatest(5, duration_seconds))
 where duration_seconds not between 5 and 60;

alter table public.session_words drop constraint if exists session_words_duration_range;
alter table public.session_words
  add constraint session_words_duration_range
  check (duration_seconds is null or duration_seconds between 5 and 60);

commit;

-- ── ROLLBACK ─────────────────────────────────────────────────────────────────
-- alter table public.session_words drop constraint if exists session_words_duration_range;
-- alter table public.session_words alter column duration_seconds drop default;
-- (the column itself is left in place: the app reads it)
