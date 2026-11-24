-- 28 · profiles.pending_approval: teacher self-registration waits for the admin
-- Part 5 (register-teacher edge function). ADDITIVE ONLY: one new column with
-- a default, two new functions, two new triggers. Nothing is dropped, no
-- existing function, policy or column is changed, no rows are deleted.
--
-- pending_approval  true  = signed up in the app, the admin hasn't approved yet
--                   false = every other account (all existing rows, teachers
--                           made with Add Teacher, approved sign-ups)
-- Approving = set-teacher-active (activate): is_active true, pending_approval
-- false, ban lifted. Leaving it pending = doing nothing. Never deleted.
--
-- 1. Guard (like protect_profile_privileges for role / is_active, migration
--    02): only an active admin, the service role (edge functions) or the SQL
--    editor can change pending_approval. A teacher can't clear their own.
--
-- 2. Sign-ups start pending, in the database: register-teacher creates the
--    auth user with app_metadata.dots_signup = 'self' (app_metadata can only
--    be set with the service role, never by the person signing up). When
--    handle_new_user (migration 03) then inserts the profile, this BEFORE
--    INSERT trigger forces role 'teacher', is_active false, pending_approval
--    true in the same transaction. So even if a later step in the function
--    fails, the account is never left looking active or approved (and the
--    auth user is created banned as well).
--
-- Safe to run more than once.

begin;

-- ── Column ───────────────────────────────────────────────────────────────────
alter table public.profiles
  add column if not exists pending_approval boolean not null default false;

-- ── 1. Only admins / the service role change pending_approval ───────────────
create or replace function public.protect_pending_approval()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  -- No logged-in user = service role (edge functions) or the SQL editor
  if auth.uid() is null or public.is_admin() then
    return new;
  end if;
  raise exception 'Only an admin can change approval status'
    using errcode = '42501'; -- insufficient_privilege
end;
$$;

drop trigger if exists protect_pending_approval on public.profiles;
create trigger protect_pending_approval
  before update on public.profiles
  for each row
  when (new.pending_approval is distinct from old.pending_approval)
  execute function public.protect_pending_approval();

-- ── 2. Accounts made by register-teacher start pending ───────────────────────
create or replace function public.signup_starts_pending()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if exists (
    select 1 from auth.users u
    where u.id = new.id
      and u.raw_app_meta_data->>'dots_signup' = 'self'
  ) then
    new.role := 'teacher';
    new.is_active := false;
    new.pending_approval := true;
  end if;
  return new;
end;
$$;

drop trigger if exists signup_starts_pending on public.profiles;
create trigger signup_starts_pending
  before insert on public.profiles
  for each row execute function public.signup_starts_pending();

-- trigger functions only; nobody calls them directly
revoke execute on function public.protect_pending_approval() from public, anon, authenticated;
revoke execute on function public.signup_starts_pending()     from public, anon, authenticated;

commit;

-- ── Check after running ──────────────────────────────────────────────────────
-- select column_name, data_type, is_nullable, column_default
-- from information_schema.columns
-- where table_schema = 'public' and table_name = 'profiles' and column_name = 'pending_approval';
--   → boolean, NO, false
-- select pending_approval, count(*) from public.profiles group by 1;   → only false
-- select tgname from pg_trigger
-- where tgrelid = 'public.profiles'::regclass and not tgisinternal order by 1;
--   → includes protect_pending_approval, protect_profile_privileges, signup_starts_pending
--
-- ── ROLLBACK ─────────────────────────────────────────────────────────────────
-- (deploy the old create-teacher / set-teacher-active first; remove register-teacher)
-- drop trigger if exists signup_starts_pending on public.profiles;
-- drop trigger if exists protect_pending_approval on public.profiles;
-- drop function if exists public.signup_starts_pending();
-- drop function if exists public.protect_pending_approval();
-- alter table public.profiles drop column if exists pending_approval;
