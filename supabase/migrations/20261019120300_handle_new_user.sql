-- 03 · New accounts are always teachers, and a failed profile insert fails sign-up
-- Policy review finding 2 (and the search_path part of finding 8).
--
-- Before: role came from raw_user_meta_data->>'role', which the person signing
-- up controls, and any error was swallowed (an account with no profile).
-- Now: role is always 'teacher'. Promote an admin by hand in the SQL editor:
--   update public.profiles set role = 'admin' where email = '...';
-- (The guard trigger from migration 02 allows that: the SQL editor has no
-- logged-in user.)

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name, role)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', ''),
    'teacher'
  );
  return new;
end;
$$;

-- ── ROLLBACK (restores the previous definition) ──────────────────────────────
-- create or replace function public.handle_new_user()
--  returns trigger language plpgsql security definer
-- as $$
-- BEGIN
--   INSERT INTO profiles (id, email, full_name, role)
--   VALUES (NEW.id, NEW.email,
--           COALESCE(NEW.raw_user_meta_data->>'full_name', ''),
--           COALESCE(NEW.raw_user_meta_data->>'role', 'teacher'));
--   RETURN NEW;
-- EXCEPTION WHEN others THEN RETURN NEW;
-- END;
-- $$;
