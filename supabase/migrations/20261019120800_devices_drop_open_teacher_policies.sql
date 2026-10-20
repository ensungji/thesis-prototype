-- 08 · Remove the open teacher policies on devices
-- Policy review finding 5 (AUDIT 3.5).
--
-- RUN ONLY AFTER every teacher phone has the app build that pairs through
-- claim_device / release_device and writes status through set_device_status
-- (migration 07). An older build pairs with a direct UPDATE, which stops
-- working here.
--
-- Leaves the anon "esp32 ..." policies alone: the devices still register with
-- the anon key until register-device and per-device secrets are live
-- (see 90_LATER_... ).
--
-- After this, teachers can:
--   read   their own students' devices + free devices
--   update their own students' devices (existing scoped policy; the new row
--          must still be paired to one of their students, so unpairing goes
--          through release_device)
--   pair / unpair / set status only through the functions in 07

drop policy if exists "teachers pair devices" on public.devices;
drop policy if exists "teachers read devices" on public.devices;

-- ── ROLLBACK ─────────────────────────────────────────────────────────────────
-- create policy "teachers pair devices" on public.devices
--   for update to authenticated using (true) with check (true);
-- create policy "teachers read devices" on public.devices
--   for select to authenticated using (true);
