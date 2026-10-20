-- 01 · is_admin() and dots_is_admin()
-- Policy review finding 8.
--   - fixed search_path (a SECURITY DEFINER function without one can be tricked
--     into using look-alike tables from another schema)
--   - a deactivated admin (is_active = false) is no longer treated as an admin
--
-- Check before running — every real admin must show is_active true or null:
--   select id, email, role, is_active from public.profiles where role = 'admin';

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin' and is_active is not false
  );
$$;

create or replace function public.dots_is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin' and is_active is not false
  );
$$;

-- ── ROLLBACK (restores the previous definitions) ─────────────────────────────
-- create or replace function public.is_admin()
--  returns boolean language sql stable security definer
-- as $$ SELECT EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin'); $$;
--
-- create or replace function public.dots_is_admin()
--  returns boolean language sql stable security definer set search_path to 'public'
-- as $$ select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin'); $$;
