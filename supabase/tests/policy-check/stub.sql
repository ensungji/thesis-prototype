-- Minimal stand-in for the live schema: only what the migrations touch.
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;

create schema auth;
create schema storage;
create schema extensions;

create function auth.uid() returns uuid language sql stable
as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;

create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb);

create function storage.foldername(name text) returns text[] language sql immutable as $$
  select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1]
$$;
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text);
alter table storage.objects enable row level security;

create table public.profiles (
  id uuid primary key, email text, full_name text, role text, title text, institution text,
  is_active boolean default true, active_device_id text,
  created_at timestamptz default now(), updated_at timestamptz default now());
create table public.students (id uuid primary key default gen_random_uuid(), teacher_id uuid, full_name text);
create table public.sessions (id uuid primary key default gen_random_uuid(), teacher_id uuid, status text);
create table public.session_words (id uuid primary key default gen_random_uuid(), session_id uuid,
  word text, order_index int, duration_seconds int);
create table public.session_students (session_id uuid, student_id uuid);
create table public.devices (id uuid primary key default gen_random_uuid(), device_code text unique,
  status text, paired_student_id uuid references public.students(id));
create table public.word_attempts (id uuid primary key default gen_random_uuid(), student_id uuid,
  session_id uuid, session_word_id uuid, word text, is_correct boolean, response_time_ms int,
  attempted_at timestamptz default now(), transcript text, transcribed_text text, confidence real,
  audio_path text, needs_review boolean default false, graded_by text default 'auto');
create table public.letter_attempts (id uuid primary key default gen_random_uuid(),
  word_attempt_id uuid references public.word_attempts(id));
create table public.word_library (id uuid primary key default gen_random_uuid(), teacher_id uuid, word text);
create table public.device_events (id uuid primary key default gen_random_uuid(), device_id uuid);
create table public.system_logs (id uuid primary key default gen_random_uuid(), source text,
  user_id uuid default auth.uid());

do $$ declare t text; begin
  foreach t in array array['profiles','students','sessions','session_words','session_students','devices',
    'word_attempts','letter_attempts','word_library','device_events','system_logs'] loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;

grant usage on schema public, storage, auth to anon, authenticated;
grant all on all tables in schema public to anon, authenticated;
grant select on storage.objects to anon, authenticated;
grant execute on function auth.uid() to anon, authenticated;

-- Existing functions / trigger / policies (from Query 2-4)
create function public.is_admin() returns boolean language sql stable security definer
as $$ select exists (select 1 from profiles where id = auth.uid() and role = 'admin') $$;
create function public.dots_is_admin() returns boolean language sql stable security definer set search_path to 'public'
as $$ select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin') $$;
create function public.handle_new_user() returns trigger language plpgsql security definer as $$
begin
  insert into profiles (id, email, full_name, role)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'full_name',''),
          coalesce(new.raw_user_meta_data->>'role','teacher'));
  return new;
exception when others then return new;
end $$;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();

create policy "Admins can update any profile" on profiles for update using ((auth.uid() = id) or is_admin());
create policy "Admins can view all profiles" on profiles for select using ((auth.uid() = id) or is_admin());
create policy "Allow profile insert" on profiles for insert with check (true);
create policy "Users can update own profile" on profiles for update using (auth.uid() = id);
create policy "Users can view own profile" on profiles for select using (auth.uid() = id);

create policy "Teachers can view own students" on students for select using (auth.uid() = teacher_id);
create policy "Teachers can view own sessions" on sessions for select using (auth.uid() = teacher_id);
create policy "Teachers can view own session words" on session_words for select using
  (exists (select 1 from sessions where sessions.id = session_words.session_id and sessions.teacher_id = auth.uid()));
create policy "Teachers can update own session words" on session_words for update using
  (exists (select 1 from sessions where sessions.id = session_words.session_id and sessions.teacher_id = auth.uid()));
create policy "Teachers can insert own session students" on session_students for insert with check
  (exists (select 1 from sessions where sessions.id = session_students.session_id and sessions.teacher_id = auth.uid()));

create policy "Teachers can view own devices" on devices for select using
  (exists (select 1 from students where students.id = devices.paired_student_id and students.teacher_id = auth.uid()));
create policy "Teachers can update own devices" on devices for update using
  (exists (select 1 from students where students.id = devices.paired_student_id and students.teacher_id = auth.uid()));
create policy "esp32 read devices" on devices for select to anon using (true);
create policy "teachers pair devices" on devices for update to authenticated using (true) with check (true);
create policy "teachers read devices" on devices for select to authenticated using (true);

create policy "Teachers can insert own word attempts" on word_attempts for insert with check
  (exists (select 1 from students where students.id = word_attempts.student_id and students.teacher_id = auth.uid()));
create policy "Teachers can view own word attempts" on word_attempts for select using
  (exists (select 1 from students where students.id = word_attempts.student_id and students.teacher_id = auth.uid()));
create policy "teachers grade attempts" on word_attempts for update to authenticated using (true) with check (true);
create policy "teachers insert attempts" on word_attempts for insert to authenticated with check (true);

create policy "Teachers can manage own word library" on word_library for all
  using ((auth.uid() = teacher_id) or (teacher_id is null)) with check (auth.uid() = teacher_id);

create policy "teachers read answers" on storage.objects for select to authenticated using (bucket_id = 'answers');

-- ── Seed ─────────────────────────────────────────────────────────────────────
-- A = teacher a…, B = teacher b…, D = admin d…
insert into profiles (id, email, role) values
  ('aaaaaaaa-0000-0000-0000-000000000000', 'a@x', 'teacher'),
  ('bbbbbbbb-0000-0000-0000-000000000000', 'b@x', 'teacher'),
  ('dddddddd-0000-0000-0000-000000000000', 'd@x', 'admin');
insert into students (id, teacher_id, full_name) values
  ('a1000000-0000-0000-0000-000000000000', 'aaaaaaaa-0000-0000-0000-000000000000', 'Ana'),
  ('a2000000-0000-0000-0000-000000000000', 'aaaaaaaa-0000-0000-0000-000000000000', 'Ben'),
  ('b1000000-0000-0000-0000-000000000000', 'bbbbbbbb-0000-0000-0000-000000000000', 'Bea');
insert into sessions (id, teacher_id, status) values
  ('5a000000-0000-0000-0000-000000000000', 'aaaaaaaa-0000-0000-0000-000000000000', 'in_progress'),
  ('5b000000-0000-0000-0000-000000000000', 'bbbbbbbb-0000-0000-0000-000000000000', 'pending');
insert into session_words (id, session_id, word, order_index) values
  ('11000000-0000-0000-0000-000000000000', '5a000000-0000-0000-0000-000000000000', 'CAT', 0),
  ('12000000-0000-0000-0000-000000000000', '5a000000-0000-0000-0000-000000000000', 'DOG', 1),
  ('13000000-0000-0000-0000-000000000000', '5a000000-0000-0000-0000-000000000000', 'SUN', 2),
  ('1b000000-0000-0000-0000-000000000000', '5b000000-0000-0000-0000-000000000000', 'BEE', 0);
insert into devices (id, device_code, status, paired_student_id) values
  ('de100000-0000-0000-0000-000000000000', 'DOTS-0001', 'connected', 'a1000000-0000-0000-0000-000000000000'),
  ('de200000-0000-0000-0000-000000000000', 'DOTS-0002', 'connected', 'b1000000-0000-0000-0000-000000000000'),
  ('de300000-0000-0000-0000-000000000000', 'DOTS-0003', 'offline', null);
-- Ana: CAT answered 3x (OLDEST is the teacher's hand grade, then 2 voice
-- answers, wrong then correct), DOG wrong, SUN needs review
insert into word_attempts (id, student_id, session_id, session_word_id, word, is_correct, attempted_at, needs_review, response_time_ms, graded_by) values
  ('f1000000-0000-0000-0000-000000000000', 'a1000000-0000-0000-0000-000000000000', '5a000000-0000-0000-0000-000000000000', '11000000-0000-0000-0000-000000000000', 'CAT', true,  now() - interval '30 min', false, 3000, 'teacher'),
  ('f2000000-0000-0000-0000-000000000000', 'a1000000-0000-0000-0000-000000000000', '5a000000-0000-0000-0000-000000000000', '11000000-0000-0000-0000-000000000000', 'CAT', false, now() - interval '29 min', false, 2000, 'auto'),
  ('f3000000-0000-0000-0000-000000000000', 'a1000000-0000-0000-0000-000000000000', '5a000000-0000-0000-0000-000000000000', '11000000-0000-0000-0000-000000000000', 'CAT', true,  now() - interval '28 min', false, 1000, null),
  ('f4000000-0000-0000-0000-000000000000', 'a1000000-0000-0000-0000-000000000000', '5a000000-0000-0000-0000-000000000000', '12000000-0000-0000-0000-000000000000', 'DOG', false, now() - interval '20 min', false, 4000, 'auto'),
  ('f5000000-0000-0000-0000-000000000000', 'a1000000-0000-0000-0000-000000000000', '5a000000-0000-0000-0000-000000000000', '13000000-0000-0000-0000-000000000000', 'SUN', true,  now() - interval '10 min', true,  5000, 'auto'),
  ('f6000000-0000-0000-0000-000000000000', 'b1000000-0000-0000-0000-000000000000', '5b000000-0000-0000-0000-000000000000', '1b000000-0000-0000-0000-000000000000', 'BEE', true,  now() - interval '5 min',  false, 1500, 'auto');
insert into letter_attempts (word_attempt_id) values ('f3000000-0000-0000-0000-000000000000');
-- answers with no student: must be left alone by the dedupe
insert into word_attempts (id, student_id, session_word_id, word) values
  ('e1000000-0000-0000-0000-000000000000', null, '11000000-0000-0000-0000-000000000000', 'CAT'),
  ('e2000000-0000-0000-0000-000000000000', null, '11000000-0000-0000-0000-000000000000', 'CAT');
insert into word_library (teacher_id, word) values (null, 'SHARED'), ('aaaaaaaa-0000-0000-0000-000000000000', 'MINE');
insert into storage.objects (bucket_id, name) values
  ('answers', '5a000000-0000-0000-0000-000000000000/a1000000-0000-0000-0000-000000000000/1_cat.wav'),
  ('answers', '5b000000-0000-0000-0000-000000000000/b1000000-0000-0000-0000-000000000000/1_bee.wav'),
  ('answers', 'odd-path.wav');
