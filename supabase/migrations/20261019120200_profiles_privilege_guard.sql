-- 02 · Teachers can't change their own role or active status
-- Policy review finding 1 (AUDIT 3.2).
--
-- "Users can update own profile" has no column limit, so a teacher could run
--   update profiles set role = 'admin' where id = auth.uid();
-- A BEFORE UPDATE trigger blocks changes to role / is_active unless the caller
-- is an active admin, or there is no logged-in user at all (the service role
-- used by edge functions, or the SQL editor). Teachers can still update their
-- other columns (full_name, title, institution, active_device_id).
--
-- Also drops "Allow profile insert" (INSERT with check true, open to anon).
-- Profiles are created by handle_new_user (SECURITY DEFINER) and by the
-- create-teacher edge function (service role); neither needs that policy.

create or replace function public.protect_profile_privileges()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  -- No logged-in user = service role (edge functions) or the SQL editor
  if auth.uid() is null or public.is_admin() then
    return new;
  end if;

  if new.role is distinct from old.role or new.is_active is distinct from old.is_active then
    raise exception 'Only an admin can change role or active status'
      using errcode = '42501'; -- insufficient_privilege
  end if;

  return new;
end;
$$;

drop trigger if exists protect_profile_privileges on public.profiles;
create trigger protect_profile_privileges
  before update on public.profiles
  for each row execute function public.protect_profile_privileges();

drop policy if exists "Allow profile insert" on public.profiles;

-- ── ROLLBACK ─────────────────────────────────────────────────────────────────
-- drop trigger if exists protect_profile_privileges on public.profiles;
-- drop function if exists public.protect_profile_privileges();
-- create policy "Allow profile insert" on public.profiles
--   for insert to public with check (true);
