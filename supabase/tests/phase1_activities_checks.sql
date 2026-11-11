-- Phase 1 (Activities) database checks. See TESTING.md, "Branch feature/activities".
--
-- Run the WHOLE file at once in the Supabase SQL Editor (after migrations 16–22 and 24).
-- It changes nothing: every test row is made inside one block that is rolled
-- back at the end. The last statement prints one row per check:
--   result = PASS / FAIL / SKIP, detail = the error or value seen.
--
-- It acts as real users (picked automatically, never modified):
--   admin    the first active admin
--   teacher  the first active teacher who has a student, and that student
--   other    another active teacher (optional: those checks SKIP without one)
--   device   the service role (what grade-answer uses)
--   anon     not signed in

drop table if exists pg_temp.p1_results;
create temp table p1_results (n serial, area text, check_name text, result text, detail text);

do $$
declare
  res       jsonb := '[]';
  v_admin   uuid;
  v_teacher uuid;
  v_student uuid;
  v_other   uuid;
  v_act     uuid;
  v_empty   uuid;
  v_dup     uuid;
  v_mine    uuid;   -- the teacher's private activity (migration 24)
  v_sess2   uuid;
  v_osess   uuid;
  v_sess    uuid;
  w         uuid[];   -- the test session's words, in order
  wa_ids    uuid[];   -- the test session's word_attempts
  e   text;
  e2  text;
  t   text;
  t2  text;
  u   uuid;
  n   int;
  n2  int;
  n3  int;
  b   boolean;
  b2  boolean;
  ts1 timestamptz;
  ts2 timestamptz;
  j   jsonb;
  j2  jsonb;
begin
  begin -- everything in here is rolled back at the end ─────────────────────

  -- ── 0 schema ───────────────────────────────────────────────────────────────
  select count(*) into n from information_schema.tables
   where table_schema = 'public' and table_name in ('activities', 'activity_words', 'answer_attempts');
  res := res || jsonb_build_array(jsonb_build_array('0 schema', 'tables activities, activity_words, answer_attempts exist', n = 3, n || ' of 3'));

  select count(*) into n from pg_trigger
   where not tgisinternal and tgname in ('activities_guard', 'activity_words_guard', 'word_attempts_grading_lock');
  res := res || jsonb_build_array(jsonb_build_array('0 schema', 'the 3 new triggers are in place', n = 3, n || ' of 3'));

  select count(*) into n from information_schema.columns
   where table_schema = 'public' and table_name = 'sessions'
     and column_name in ('activity_id', 'activity_name', 'current_index');
  select count(*) into n2 from information_schema.columns
   where table_schema = 'public' and table_name = 'word_attempts'
     and column_name in ('tries', 'original_is_correct', 'original_graded_by', 'regraded_by', 'regraded_at');
  res := res || jsonb_build_array(jsonb_build_array('0 schema', 'new columns on sessions (3) and word_attempts (5)', n = 3 and n2 = 5, n || ' + ' || n2));

  select exists (select 1 from pg_constraint where conname = 'word_attempts_session_word_id_fkey' and confdeltype = 'n') into b;
  res := res || jsonb_build_array(jsonb_build_array('0 schema', 'word_attempts.session_word_id foreign key is ON DELETE SET NULL', b, null));

  select count(*) into n from information_schema.columns
   where table_schema = 'public' and table_name = 'activities' and column_name = 'shared';
  select count(*) into n2 from activities a join profiles p on p.id = a.created_by
   where p.role = 'admin' and not a.shared;
  res := res || jsonb_build_array(jsonb_build_array('0 schema', 'activities.shared exists; every activity an admin made is shared (migration 24)',
           n = 1 and n2 = 0, format('column %s, admin-made not shared %s', n, n2)));

  -- ── setup: pick the users ──────────────────────────────────────────────────
  select id into v_admin from profiles
   where role = 'admin' and is_active is not false order by id limit 1;
  select s.teacher_id, s.id into v_teacher, v_student
    from students s join profiles p on p.id = s.teacher_id
   where p.role = 'teacher' and p.is_active is not false
   order by p.id, s.id limit 1;
  select id into v_other from profiles
   where role = 'teacher' and is_active is not false and id is distinct from v_teacher
   order by id limit 1;
  res := res || jsonb_build_array(jsonb_build_array('setup', 'found an active admin and a teacher with a student',
           v_admin is not null and v_teacher is not null,
           format('admin %s, teacher %s, student %s, other teacher %s', v_admin, v_teacher, v_student, coalesce(v_other::text, 'none'))));
  if v_admin is null or v_teacher is null then
    raise exception 'P1_DONE';
  end if;

  -- ── 1 activities ───────────────────────────────────────────────────────────
  -- as admin
  perform set_config('request.jwt.claim.sub', v_admin::text, true),
          set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true),
          set_config('role', 'authenticated', true);

  insert into activities (name, level, created_by, shared) values ('P1 test', 'easy', v_teacher, false) returning id into v_act;
  select status, created_by, shared into t, u, b from activities where id = v_act;
  res := res || jsonb_build_array(jsonb_build_array('1 activities', 'admin creates a draft; created_by is the admin and it is shared (not what was sent)',
           t = 'draft' and u = v_admin and b, t || ', shared ' || b));

  insert into activity_words (activity_id, position, word) values (v_act, 0, 'CAT');
  insert into activity_words (activity_id, position, word, duration_seconds) values (v_act, 1, 'DOG', 30), (v_act, 2, 'SUN', 5);
  select duration_seconds into n from activity_words where activity_id = v_act and position = 0;
  res := res || jsonb_build_array(jsonb_build_array('1 activities', 'a word''s time defaults to 20 s', n = 20, n || ' s'));

  e := null; begin insert into activity_words (activity_id, position, word) values (v_act, 9, 'cat');
  exception when others then e := sqlstate || ' ' || sqlerrm; end;
  e2 := null; begin insert into activity_words (activity_id, position, word, duration_seconds) values (v_act, 9, 'COW', 61);
  exception when others then e2 := sqlstate || ' ' || sqlerrm; end;
  res := res || jsonb_build_array(jsonb_build_array('1 activities', 'lower-case word and a 61 s time are refused',
           e like '%activity_words_word_check%' and e2 like '%activity_words_duration_range%', e || ' / ' || e2));

  insert into activities (name) values ('P1 empty') returning id into v_empty;
  e := null; begin update activities set status = 'published' where id = v_empty;
  exception when others then e := sqlstate || ' ' || sqlerrm; end;
  res := res || jsonb_build_array(jsonb_build_array('1 activities', 'a draft with no words can''t be published', e like '%at least one word%', e));

  -- as teacher
  perform set_config('request.jwt.claim.sub', v_teacher::text, true),
          set_config('request.jwt.claims', json_build_object('sub', v_teacher, 'role', 'authenticated')::text, true),
          set_config('role', 'authenticated', true);
  select count(*) into n from activities where id in (v_act, v_empty);
  select count(*) into n2 from activity_words where activity_id = v_act;
  res := res || jsonb_build_array(jsonb_build_array('1 activities', 'a teacher can''t see drafts or their words', n = 0 and n2 = 0, n || ' / ' || n2));
  e := null; n := 0; begin
    insert into activities (name) values ('P1 teacher') returning id into u;
    delete from activities where id = u;
    get diagnostics n = row_count;
  exception when others then e := sqlstate || ' ' || sqlerrm; end;
  res := res || jsonb_build_array(jsonb_build_array('1 activities', 'a teacher can create and delete their own draft', e is null and n = 1, coalesce(e, n || ' deleted')));

  -- as admin: publish
  perform set_config('request.jwt.claim.sub', v_admin::text, true),
          set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true),
          set_config('role', 'authenticated', true);
  update activities set status = 'published' where id = v_act;
  select published_at is not null into b from activities where id = v_act;
  res := res || jsonb_build_array(jsonb_build_array('1 activities', 'publishing sets published_at', b, null));

  e := null; begin update activities set name = 'P1 renamed' where id = v_act;
  exception when others then e := sqlstate || ' ' || sqlerrm; end;
  res := res || jsonb_build_array(jsonb_build_array('1 activities', 'published: editing is refused', e like '%can''t be edited%', e));
  e := null; begin insert into activity_words (activity_id, position, word) values (v_act, 5, 'COW');
  exception when others then e := sqlstate || ' ' || sqlerrm; end;
  res := res || jsonb_build_array(jsonb_build_array('1 activities', 'published: adding a word is refused', e like '%can''t be changed%', e));
  e := null; begin update activities set status = 'draft' where id = v_act;
  exception when others then e := sqlstate || ' ' || sqlerrm; end;
  res := res || jsonb_build_array(jsonb_build_array('1 activities', 'published: going back to draft is refused', e like '%back to draft%', e));
  delete from activities where id = v_act;
  get diagnostics n = row_count;
  res := res || jsonb_build_array(jsonb_build_array('1 activities', 'an admin can''t delete a published activity (0 rows)', n = 0, n || ' rows'));

  -- as teacher: sees the published one
  perform set_config('request.jwt.claim.sub', v_teacher::text, true),
          set_config('request.jwt.claims', json_build_object('sub', v_teacher, 'role', 'authenticated')::text, true),
          set_config('role', 'authenticated', true);
  select count(*) into n from activity_words where activity_id = v_act;
  res := res || jsonb_build_array(jsonb_build_array('1 activities', 'a teacher sees the published activity''s 3 words', n = 3, n || ' words'));

  -- as admin: hide, un-hide, duplicate
  perform set_config('request.jwt.claim.sub', v_admin::text, true),
          set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true),
          set_config('role', 'authenticated', true);
  update activities set status = 'hidden' where id = v_act;
  perform set_config('request.jwt.claim.sub', v_teacher::text, true),
          set_config('request.jwt.claims', json_build_object('sub', v_teacher, 'role', 'authenticated')::text, true),
          set_config('role', 'authenticated', true);
  select count(*) into n from activities where id = v_act;
  res := res || jsonb_build_array(jsonb_build_array('1 activities', 'hidden: a teacher no longer sees it', n = 0, n || ' rows'));
  perform set_config('request.jwt.claim.sub', v_admin::text, true),
          set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true),
          set_config('role', 'authenticated', true);
  update activities set status = 'published' where id = v_act;

  v_dup := duplicate_activity(v_act);
  select a.status, a.name, (select string_agg(word, ' ' order by position) from activity_words where activity_id = a.id)
    into t, t2, e from activities a where a.id = v_dup;
  res := res || jsonb_build_array(jsonb_build_array('1 activities', 'duplicate_activity makes a draft with the same words',
           t = 'draft' and t2 = 'P1 test (copy)' and e = 'CAT DOG SUN', t2 || ': ' || coalesce(e, '-')));

  perform set_config('request.jwt.claim.sub', v_teacher::text, true),
          set_config('request.jwt.claims', json_build_object('sub', v_teacher, 'role', 'authenticated')::text, true),
          set_config('role', 'authenticated', true);
  e := null; begin
    u := duplicate_activity(v_act);
    select status, shared, created_by = v_teacher, (select count(*) from activity_words where activity_id = u)
      into t, b, b2, n from activities where id = u;
  exception when others then e := sqlstate || ' ' || sqlerrm; end;
  res := res || jsonb_build_array(jsonb_build_array('1 activities', 'a teacher duplicates a shared activity: their own private draft, same words',
           e is null and t = 'draft' and not b and b2 and n = 3, coalesce(e, format('%s, shared %s, theirs %s, %s words', t, b, b2, n))));

  -- as anon
  perform set_config('request.jwt.claim.sub', '', true), set_config('request.jwt.claims', '', true), set_config('role', 'anon', true);
  e := null; begin perform count(*) from activities;
  exception when others then e := sqlstate || ' ' || sqlerrm; end;
  res := res || jsonb_build_array(jsonb_build_array('1 activities', 'not signed in: no access', e like '%permission denied%', e));

  -- ── 2 sessions + start_activity_session ────────────────────────────────────
  perform set_config('request.jwt.claim.sub', v_teacher::text, true),
          set_config('request.jwt.claims', json_build_object('sub', v_teacher, 'role', 'authenticated')::text, true),
          set_config('role', 'authenticated', true);
  e := null; begin insert into sessions (teacher_id, name, type) values (v_teacher, 'P1', 'live_session');
  exception when others then e := sqlstate || ' ' || sqlerrm; end;
  res := res || jsonb_build_array(jsonb_build_array('2 sessions', 'type live_session is still refused (the app''s fallback needs that)', e like '%sessions_type_check%', e));

  insert into sessions (teacher_id, name) values (v_teacher, 'P1 test session') returning id into v_sess;
  n := start_activity_session(v_sess, v_act);
  select array_agg(id order by order_index), string_agg(word || ':' || duration_seconds, ' ' order by order_index)
    into w, t from session_words where session_id = v_sess;
  res := res || jsonb_build_array(jsonb_build_array('2 sessions', 'start_activity_session copies the words in order with their times',
           n = 3 and t = 'CAT:20 DOG:30 SUN:5', t));
  select type, activity_name, current_index, activity_id = v_act, status into t, t2, n2, b, e from sessions where id = v_sess;
  res := res || jsonb_build_array(jsonb_build_array('2 sessions', 'the session becomes type activity, name copied, index 0, still pending',
           t = 'activity' and t2 = 'P1 test' and n2 = 0 and b and e = 'pending', format('%s / %s / %s / %s', t, t2, n2, e)));
  n := start_activity_session(v_sess, v_act);
  select count(*) into n2 from session_words where session_id = v_sess;
  res := res || jsonb_build_array(jsonb_build_array('2 sessions', 'calling it again (app retry) changes nothing', n = 3 and n2 = 3, n2 || ' words'));
  e := null; begin perform start_activity_session(v_sess, v_dup);
  exception when others then e := sqlstate || ' ' || sqlerrm; end;
  res := res || jsonb_build_array(jsonb_build_array('2 sessions', 'a draft activity is refused', e like '%Only a published activity%', e));

  perform set_config('request.jwt.claim.sub', v_admin::text, true),
          set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true),
          set_config('role', 'authenticated', true);
  e := null; begin perform start_activity_session(v_sess, v_act);
  exception when others then e := sqlstate || ' ' || sqlerrm; end;
  res := res || jsonb_build_array(jsonb_build_array('2 sessions', 'only the session''s teacher can start it (an admin is refused)', e like '%Not your session%', e));

  -- ── 3 answer_attempts ──────────────────────────────────────────────────────
  perform set_config('request.jwt.claim.sub', '', true), set_config('request.jwt.claims', '', true), set_config('role', 'service_role', true);
  e := null; begin
    insert into answer_attempts (session_word_id, student_id, attempt_no, result, transcript)
    values (w[2], v_student, 1, 'wrong', 'dot'), (w[2], v_student, 2, 'correct', 'dog');
  exception when others then e := sqlstate || ' ' || sqlerrm; end;
  res := res || jsonb_build_array(jsonb_build_array('3 answer_attempts', 'the device (service role) saves tries', e is null, e));
  e := null; begin
    insert into answer_attempts (session_word_id, student_id, attempt_no, result) values (w[2], v_student, 2, 'wrong');
  exception when others then e := sqlstate || ' ' || sqlerrm; end;
  res := res || jsonb_build_array(jsonb_build_array('3 answer_attempts', 'the same try number can''t be saved twice', e like '%answer_attempts_one_per_try%', e));

  perform set_config('request.jwt.claim.sub', v_teacher::text, true),
          set_config('request.jwt.claims', json_build_object('sub', v_teacher, 'role', 'authenticated')::text, true),
          set_config('role', 'authenticated', true);
  select count(*) into n from answer_attempts where session_word_id = w[2];
  res := res || jsonb_build_array(jsonb_build_array('3 answer_attempts', 'the session''s teacher reads them', n = 2, n || ' rows'));
  e := null; begin
    insert into answer_attempts (session_word_id, student_id, attempt_no, result) values (w[2], v_student, 9, 'correct');
  exception when others then e := sqlstate || ' ' || sqlerrm; end;
  res := res || jsonb_build_array(jsonb_build_array('3 answer_attempts', 'a teacher can''t write them', e like '%permission denied%', e));

  if v_other is not null then
    perform set_config('request.jwt.claim.sub', v_other::text, true),
            set_config('request.jwt.claims', json_build_object('sub', v_other, 'role', 'authenticated')::text, true),
            set_config('role', 'authenticated', true);
    select count(*) into n from answer_attempts where session_word_id = w[2];
    res := res || jsonb_build_array(jsonb_build_array('3 answer_attempts', 'another teacher sees none of them', n = 0, n || ' rows'));
  else
    res := res || jsonb_build_array(jsonb_build_array('3 answer_attempts', 'another teacher sees none of them', null, 'SKIP: no second teacher'));
  end if;

  perform set_config('request.jwt.claim.sub', '', true), set_config('request.jwt.claims', '', true), set_config('role', 'anon', true);
  e := null; begin perform count(*) from answer_attempts;
  exception when others then e := sqlstate || ' ' || sqlerrm; end;
  res := res || jsonb_build_array(jsonb_build_array('3 answer_attempts', 'not signed in: no access', e like '%permission denied%', e));

  -- ── 4 grading lock ─────────────────────────────────────────────────────────
  perform set_config('request.jwt.claim.sub', v_teacher::text, true),
          set_config('request.jwt.claims', json_build_object('sub', v_teacher, 'role', 'authenticated')::text, true),
          set_config('role', 'authenticated', true);
  update sessions set status = 'in_progress', started_at = now() where id = v_sess;

  -- the device answers: CAT correct, DOG wrong; SUN = No answer
  perform set_config('request.jwt.claim.sub', '', true), set_config('request.jwt.claims', '', true), set_config('role', 'service_role', true);
  insert into word_attempts (student_id, session_id, session_word_id, word, is_correct, needs_review, graded_by, tries) values
    (v_student, v_sess, w[1], 'CAT', true,  false, 'auto',   1),
    (v_student, v_sess, w[2], 'DOG', false, false, 'auto',   1),
    (v_student, v_sess, w[3], 'SUN', false, false, 'missed', 0);
  select array_agg(id) into wa_ids from word_attempts where session_id = v_sess;

  perform set_config('request.jwt.claim.sub', v_teacher::text, true),
          set_config('request.jwt.claims', json_build_object('sub', v_teacher, 'role', 'authenticated')::text, true),
          set_config('role', 'authenticated', true);
  e := null; begin
    insert into word_attempts (student_id, session_id, word, is_correct, graded_by) values (v_student, v_sess, 'X', true, 'auto');
  exception when others then e := sqlstate || ' ' || sqlerrm; end;
  res := res || jsonb_build_array(jsonb_build_array('4 grading lock', 'a teacher can''t create a voice row', e like '%Only the device%', e));
  e := null; begin
    update word_attempts set is_correct = true, needs_review = false, graded_by = 'teacher'
     where session_word_id = w[2] and student_id = v_student;
  exception when others then e := sqlstate || ' ' || sqlerrm; end;
  res := res || jsonb_build_array(jsonb_build_array('4 grading lock', 'session active: a teacher can''t change a voice row', e like '%locked until the session ends%', e));
  e := null; begin
    update word_attempts set is_correct = true, needs_review = false, graded_by = 'teacher'
     where session_word_id = w[3] and student_id = v_student;
  exception when others then e := sqlstate || ' ' || sqlerrm; end;
  select regraded_at is null, graded_by into b, t from word_attempts where session_word_id = w[3] and student_id = v_student;
  res := res || jsonb_build_array(jsonb_build_array('4 grading lock', 'session active: a teacher can grade a No answer row (not a re-grade)',
           e is null and b and t = 'teacher', coalesce(e, t)));
  e := null; begin
    update word_attempts set transcript = 'edited' where session_word_id = w[3] and student_id = v_student;
  exception when others then e := sqlstate || ' ' || sqlerrm; end;
  res := res || jsonb_build_array(jsonb_build_array('4 grading lock', 'a teacher can only change the grade columns', e like '%only change the grade%', e));

  -- the device: retries
  perform set_config('request.jwt.claim.sub', '', true), set_config('request.jwt.claims', '', true), set_config('role', 'service_role', true);
  e := null; begin
    update word_attempts set is_correct = true, needs_review = true, transcript = 'review', tries = 2
     where session_word_id = w[2] and student_id = v_student;
    update word_attempts set is_correct = false, needs_review = false, transcript = 'wrong again', tries = 3
     where session_word_id = w[2] and student_id = v_student;
    update word_attempts set is_correct = true, needs_review = false, transcript = 'dog', tries = 4
     where session_word_id = w[2] and student_id = v_student;
  exception when others then e := sqlstate || ' ' || sqlerrm; end;
  res := res || jsonb_build_array(jsonb_build_array('4 grading lock', 'device: wrong → review (is_correct true) → wrong → correct, each replaces the last', e is null, e));
  e := null; begin
    update word_attempts set is_correct = false, transcript = 'cap', tries = 2
     where session_word_id = w[1] and student_id = v_student;
  exception when others then e := sqlstate || ' ' || sqlerrm; end;
  res := res || jsonb_build_array(jsonb_build_array('4 grading lock', 'device: a later voice answer can''t replace a correct one (DT001)', e like 'DT001%', e));
  e := null; begin
    update word_attempts set tries = 2 where session_word_id = w[1] and student_id = v_student;
  exception when others then e := sqlstate || ' ' || sqlerrm; end;
  select is_correct, tries into b, n from word_attempts where session_word_id = w[1] and student_id = v_student;
  res := res || jsonb_build_array(jsonb_build_array('4 grading lock', 'device: tries still goes up; the correct result is kept', e is null and b and n = 2, coalesce(e, b || ', tries ' || n)));

  -- session ends: re-grades
  perform set_config('request.jwt.claim.sub', v_teacher::text, true),
          set_config('request.jwt.claims', json_build_object('sub', v_teacher, 'role', 'authenticated')::text, true),
          set_config('role', 'authenticated', true);
  update sessions set status = 'finished', finished_at = now() where id = v_sess;
  e := null; begin
    update word_attempts set is_correct = false, needs_review = false, graded_by = 'teacher'
     where session_word_id = w[1] and student_id = v_student;
  exception when others then e := sqlstate || ' ' || sqlerrm; end;
  select original_is_correct, original_graded_by, regraded_by = v_teacher, regraded_at, graded_by
    into b, t, b2, ts1, t2 from word_attempts where session_word_id = w[1] and student_id = v_student;
  res := res || jsonb_build_array(jsonb_build_array('4 grading lock', 'session ended: the first re-grade saves the original (true, auto, who, when)',
           e is null and b and t = 'auto' and b2 and ts1 is not null and t2 = 'teacher',
           coalesce(e, format('original %s / %s, by teacher %s, at %s', b, t, b2, ts1))));
  update word_attempts set is_correct = true where session_word_id = w[1] and student_id = v_student;
  select original_is_correct, regraded_at into b, ts2 from word_attempts where session_word_id = w[1] and student_id = v_student;
  res := res || jsonb_build_array(jsonb_build_array('4 grading lock', 'a second re-grade doesn''t change the saved original', b and ts2 = ts1, format('%s / %s', b, ts2)));

  perform set_config('request.jwt.claim.sub', '', true), set_config('request.jwt.claims', '', true), set_config('role', 'service_role', true);
  e := null; begin
    update word_attempts set is_correct = false, transcript = 'late', tries = 5
     where session_word_id = w[2] and student_id = v_student;
  exception when others then e := sqlstate || ' ' || sqlerrm; end;
  res := res || jsonb_build_array(jsonb_build_array('4 grading lock', 'session ended: the correct lock still holds for the device', e like 'DT001%', e));

  perform set_config('request.jwt.claim.sub', v_teacher::text, true),
          set_config('request.jwt.claims', json_build_object('sub', v_teacher, 'role', 'authenticated')::text, true),
          set_config('role', 'authenticated', true);
  e := null; begin update word_attempts set graded_by = 'skipped' where session_word_id = w[3] and student_id = v_student;
  exception when others then e := sqlstate || ' ' || sqlerrm; end;
  e2 := null; begin update word_attempts set graded_by = 'bogus' where session_word_id = w[3] and student_id = v_student;
  exception when others then e2 := sqlstate || ' ' || sqlerrm; end;
  res := res || jsonb_build_array(jsonb_build_array('4 grading lock', 'graded_by ''skipped'' is accepted, an unknown value refused',
           e is null and e2 like '%graded_by_check%', coalesce(e, e2)));

  -- ── 5 nothing else is touched ──────────────────────────────────────────────
  perform set_config('request.jwt.claim.sub', v_admin::text, true),
          set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true),
          set_config('role', 'authenticated', true);
  update activities set status = 'hidden' where id = v_act;
  perform set_config('request.jwt.claim.sub', '', true), set_config('request.jwt.claims', '', true), set_config('role', 'service_role', true);
  delete from activities where id = v_act; -- only possible outside the app (admins can't delete a published one)
  select activity_id is null and activity_name = 'P1 test' into b from sessions where id = v_sess;
  select count(*) into n from session_words where session_id = v_sess;
  select count(*) into n2 from word_attempts where id = any (wa_ids) and session_id = v_sess;
  res := res || jsonb_build_array(jsonb_build_array('5 safety', 'hiding + deleting the activity leaves the session, its 3 words and 3 results',
           b and n = 3 and n2 = 3, format('session kept: %s, words %s, results %s', b, n, n2)));

  perform set_config('request.jwt.claim.sub', v_teacher::text, true),
          set_config('request.jwt.claims', json_build_object('sub', v_teacher, 'role', 'authenticated')::text, true),
          set_config('role', 'authenticated', true);
  select jsonb_agg(to_jsonb(x)) into j from teacher_student_stats() x where x.student_id = v_student;
  update sessions set status = 'paused' where id = v_sess; -- delete while still active
  delete from sessions where id = v_sess;
  get diagnostics n = row_count;
  select jsonb_agg(to_jsonb(x)) into j2 from teacher_student_stats() x where x.student_id = v_student;
  perform set_config('request.jwt.claim.sub', '', true), set_config('request.jwt.claims', '', true), set_config('role', 'service_role', true);
  select count(*) into n2 from word_attempts where id = any (wa_ids) and session_id is null and session_word_id is null;
  select count(*) into n3 from answer_attempts where session_word_id = any (w);
  res := res || jsonb_build_array(jsonb_build_array('5 safety', 'a teacher can delete an active session; results stay (ids emptied), tries go',
           n = 1 and n2 = 3 and n3 = 0, format('deleted %s, results kept %s, tries left %s', n, n2, n3)));
  res := res || jsonb_build_array(jsonb_build_array('5 safety', 'the student''s analytics are the same after the delete', j = j2, j2::text));

  -- ── 6 teacher activities (migration 24) ────────────────────────────────────
  perform set_config('request.jwt.claim.sub', v_teacher::text, true),
          set_config('request.jwt.claims', json_build_object('sub', v_teacher, 'role', 'authenticated')::text, true),
          set_config('role', 'authenticated', true);
  insert into activities (name, shared) values ('P1 mine', true) returning id into v_mine;
  select created_by, shared into u, b from activities where id = v_mine;
  res := res || jsonb_build_array(jsonb_build_array('6 teacher activities', 'a teacher''s new activity is theirs and private (shared sent true is ignored)',
           u = v_teacher and not b, 'shared ' || b));
  e := null; begin
    insert into activity_words (activity_id, position, word) values (v_mine, 0, 'HAT'), (v_mine, 1, 'MAP'), (v_mine, 2, 'PEN');
    update activity_words set duration_seconds = 10 where activity_id = v_mine and position = 1;
    delete from activity_words where activity_id = v_mine and position = 2;
    update activities set description = 'edited', level = 'hard' where id = v_mine;
  exception when others then e := sqlstate || ' ' || sqlerrm; end;
  select count(*) into n from activity_words where activity_id = v_mine;
  res := res || jsonb_build_array(jsonb_build_array('6 teacher activities', 'the teacher edits their draft and its words', e is null and n = 2, coalesce(e, n || ' words')));
  e := null; begin update activities set shared = true where id = v_mine;
  exception when others then e := sqlstate || ' ' || sqlerrm; end;
  res := res || jsonb_build_array(jsonb_build_array('6 teacher activities', 'a teacher can''t share their own activity', e like '%Only an admin can change whether%', e));
  e := null; begin
    update activities set status = 'published' where id = v_mine;
    update activities set status = 'hidden' where id = v_mine;
    update activities set status = 'published' where id = v_mine;
  exception when others then e := sqlstate || ' ' || sqlerrm; end;
  select status into t from activities where id = v_mine;
  res := res || jsonb_build_array(jsonb_build_array('6 teacher activities', 'the teacher publishes, hides and un-hides their own', e is null and t = 'published', coalesce(e, t)));
  e := null; begin update activities set name = 'P1 renamed' where id = v_mine;
  exception when others then e := sqlstate || ' ' || sqlerrm; end;
  delete from activities where id = v_mine;
  get diagnostics n = row_count;
  res := res || jsonb_build_array(jsonb_build_array('6 teacher activities', 'published: locked for the teacher too, and can''t be deleted',
           e like '%can''t be edited%' and n = 0, e || ' / ' || n || ' deleted'));

  if v_other is not null then
    perform set_config('request.jwt.claim.sub', v_other::text, true),
            set_config('request.jwt.claims', json_build_object('sub', v_other, 'role', 'authenticated')::text, true),
            set_config('role', 'authenticated', true);
    select count(*) into n from activities where id = v_mine;
    select count(*) into n2 from activity_words where activity_id = v_mine;
    res := res || jsonb_build_array(jsonb_build_array('6 teacher activities', 'another teacher can''t see it or its words', n = 0 and n2 = 0, n || ' / ' || n2));
    update activities set status = 'hidden' where id = v_mine;
    get diagnostics n = row_count;
    e := null; begin insert into activity_words (activity_id, position, word) values (v_mine, 5, 'COW');
    exception when others then e := sqlstate || ' ' || sqlerrm; end;
    res := res || jsonb_build_array(jsonb_build_array('6 teacher activities', 'another teacher can''t change it or add words (refused by RLS or the edit lock)',
             n = 0 and (e like '%row-level security%' or e like '%can''t be changed%'), n || ' rows / ' || e));
    e := null; begin perform duplicate_activity(v_mine);
    exception when others then e := sqlstate || ' ' || sqlerrm; end;
    res := res || jsonb_build_array(jsonb_build_array('6 teacher activities', 'another teacher can''t duplicate it', e like '%No such activity%', e));
    insert into sessions (teacher_id, name) values (v_other, 'P1 other session') returning id into v_osess;
    e := null; begin perform start_activity_session(v_osess, v_mine);
    exception when others then e := sqlstate || ' ' || sqlerrm; end;
    res := res || jsonb_build_array(jsonb_build_array('6 teacher activities', 'another teacher can''t start it', e like '%Only a published activity%', e));
  else
    res := res || jsonb_build_array(jsonb_build_array('6 teacher activities', 'another teacher can''t see it or its words', null, 'SKIP: no second teacher'));
    res := res || jsonb_build_array(jsonb_build_array('6 teacher activities', 'another teacher can''t change it or add words (refused by RLS or the edit lock)', null, 'SKIP: no second teacher'));
    res := res || jsonb_build_array(jsonb_build_array('6 teacher activities', 'another teacher can''t duplicate it', null, 'SKIP: no second teacher'));
    res := res || jsonb_build_array(jsonb_build_array('6 teacher activities', 'another teacher can''t start it', null, 'SKIP: no second teacher'));
  end if;

  perform set_config('request.jwt.claim.sub', v_admin::text, true),
          set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true),
          set_config('role', 'authenticated', true);
  select count(*) into n from activity_words where activity_id = v_mine;
  u := duplicate_activity(v_mine);
  select shared, created_by = v_admin into b, b2 from activities where id = u;
  res := res || jsonb_build_array(jsonb_build_array('6 teacher activities', 'an admin sees it; the admin''s copy of it is shared',
           n = 2 and b and b2, format('%s words, copy shared %s, admin''s %s', n, b, b2)));

  perform set_config('request.jwt.claim.sub', v_teacher::text, true),
          set_config('request.jwt.claims', json_build_object('sub', v_teacher, 'role', 'authenticated')::text, true),
          set_config('role', 'authenticated', true);
  insert into sessions (teacher_id, name) values (v_teacher, 'P1 mine session') returning id into v_sess2;
  e := null; n := null; begin n := start_activity_session(v_sess2, v_mine);
  exception when others then e := sqlstate || ' ' || sqlerrm; end;
  res := res || jsonb_build_array(jsonb_build_array('6 teacher activities', 'the teacher starts a session with their own private activity',
           e is null and n = 2, coalesce(e, n || ' words')));

  raise exception 'P1_DONE';
  exception when others then
    if sqlerrm <> 'P1_DONE' then
      res := res || jsonb_build_array(jsonb_build_array('ERROR', 'the script stopped early', false, sqlstate || ' ' || sqlerrm));
    end if;
  end; -- everything above is now rolled back ──────────────────────────────────

  insert into p1_results (area, check_name, result, detail)
  select x->>0, x->>1,
         case when x->>2 = 'true' then 'PASS' when x->>2 is null and x->>3 like 'SKIP%' then 'SKIP' else 'FAIL' end,
         x->>3
  from jsonb_array_elements(res) x;
end $$;

select n, area, check_name, result, detail from p1_results
union all
select null, 'TOTAL', count(*) filter (where result = 'PASS') || ' passed, ' || count(*) filter (where result = 'FAIL') || ' failed',
       null, null from p1_results
order by n nulls last;
