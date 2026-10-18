-- 07 · Device pairing and status through functions (ADDITIVE: nothing is removed)
-- Policy review finding 5 (AUDIT 3.5). Run this BEFORE installing the app
-- build that calls these functions. The open policies are dropped later, in 08.
--
-- Every function checks the caller itself (SECURITY DEFINER), and EXECUTE is
-- taken away from anon: by default every role, including anon, may call a
-- new function.

-- Pair a device to one of YOUR students. One device per student at a time,
-- and any of your students can use any of your devices:
--   - the student's previous device (if any) is released
--   - a device that's with ANOTHER of your students moves to this one
--   - a device that's with ANOTHER TEACHER's student is refused (nothing changes)
create or replace function public.claim_device(p_device uuid, p_student uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_holder uuid;
  v_holder_teacher uuid;
begin
  if not exists (select 1 from students where id = p_student and teacher_id = auth.uid()) then
    raise exception 'not your student' using errcode = '42501';
  end if;

  -- Lock the device row: two teachers tapping at once can't both get it
  select d.paired_student_id, s.teacher_id
    into v_holder, v_holder_teacher
    from devices d
    left join students s on s.id = d.paired_student_id
   where d.id = p_device
     for update of d;

  if not found then
    raise exception 'no such device' using errcode = 'P0002';
  end if;
  if v_holder is not null and v_holder_teacher is distinct from auth.uid() then
    raise exception 'device already paired' using errcode = 'P0001';
  end if;

  update devices set paired_student_id = null
   where paired_student_id = p_student and id <> p_device;

  -- free, already this student's, or moved from another of your students
  update devices set paired_student_id = p_student where id = p_device;
end;
$$;

-- Unpair whatever device one of YOUR students has.
create or replace function public.release_device(p_student uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (select 1 from students where id = p_student and teacher_id = auth.uid()) then
    raise exception 'not your student' using errcode = '42501';
  end if;
  update devices set paired_student_id = null where paired_student_id = p_student;
end;
$$;

-- Online / offline, written by the app's presence module. Only for devices
-- that are free or paired to one of YOUR students. Writes only real changes
-- (the devices trigger logs each one).
create or replace function public.set_device_status(p_device uuid, p_status text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if p_status not in ('connected', 'offline') then
    raise exception 'invalid status %', p_status using errcode = '22023';
  end if;

  update devices d set status = p_status
   where d.id = p_device
     and d.status is distinct from p_status
     and (
       d.paired_student_id is null
       or exists (
         select 1 from students s
         where s.id = d.paired_student_id and s.teacher_id = auth.uid()
       )
     );
end;
$$;

-- The pairing list: every device, but a device paired to ANOTHER teacher's
-- student only shows as taken (paired_student_id = null, taken = true), so no
-- other class's student ids or names are exposed.
create or replace function public.list_pairing_devices()
returns table (id uuid, device_code text, status text, paired_student_id uuid, taken boolean)
language sql
stable
security definer
set search_path = public
as $$
  select d.id,
         d.device_code::text,
         d.status::text,
         case when s.teacher_id = auth.uid() then d.paired_student_id end,
         d.paired_student_id is not null
  from devices d
  left join students s on s.id = d.paired_student_id
  where auth.uid() is not null
  order by d.device_code;
$$;

revoke execute on function public.claim_device(uuid, uuid)         from public, anon;
revoke execute on function public.release_device(uuid)             from public, anon;
revoke execute on function public.set_device_status(uuid, text)    from public, anon;
revoke execute on function public.list_pairing_devices()           from public, anon;
grant  execute on function public.claim_device(uuid, uuid)         to authenticated;
grant  execute on function public.release_device(uuid)             to authenticated;
grant  execute on function public.set_device_status(uuid, text)    to authenticated;
grant  execute on function public.list_pairing_devices()           to authenticated;

-- Scoped read: a teacher sees their own students' devices (existing policy
-- "Teachers can view own devices") plus free devices. Replaces, in 08, the
-- open "teachers read devices".
drop policy if exists "Teachers can view free devices" on public.devices;
create policy "Teachers can view free devices"
  on public.devices
  for select
  to authenticated
  using (paired_student_id is null);

-- ── ROLLBACK ─────────────────────────────────────────────────────────────────
-- (Only needed if 08 has NOT run; otherwise roll back 08 first.)
-- drop policy if exists "Teachers can view free devices" on public.devices;
-- drop function if exists public.claim_device(uuid, uuid);
-- drop function if exists public.release_device(uuid);
-- drop function if exists public.set_device_status(uuid, text);
-- drop function if exists public.list_pairing_devices();
