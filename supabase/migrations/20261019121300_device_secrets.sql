-- 13 · Per-device secrets (storage only; nothing is enforced yet)
-- AUDIT 3.4.
--
-- The secret hashes live in their own table, NOT in a devices column:
-- devices is readable with the anon key ("esp32 read devices"), so a column
-- there would hand every hash to anyone. This table has RLS on and no
-- policies, so only the service role (edge functions) can read or write it.
--
-- Used by:
--   register-device  (new edge function) - the device proves who it is at boot
--   grade-answer     - checks the secret on every answer
-- Both accept a device that has NO row here, unless the edge-function secret
-- REQUIRE_DEVICE_SECRET is "true". So this table can be filled one device at
-- a time while devices are reflashed.

create table if not exists public.device_secrets (
  device_id   uuid primary key references public.devices (id) on delete cascade,
  secret_hash text not null,          -- lowercase hex SHA-256 of the secret
  created_at  timestamptz not null default now()
);

alter table public.device_secrets enable row level security;
revoke all on public.device_secrets from anon, authenticated;

-- ── Per device (run by hand, one per device; never commit the secret) ────────
-- 1. Make a secret (32+ random characters), e.g. in PowerShell:
--      -join ((48..57)+(65..90)+(97..122) | Get-Random -Count 32 | % {[char]$_})
-- 2. Hash it on your computer, so the secret never lands in SQL history:
--      PowerShell: $s='<secret>'; -join ([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($s)) | % { $_.ToString('x2') })
--      Git Bash:   printf '%s' '<secret>' | sha256sum
-- 3. Store the hash:
--      insert into public.device_secrets (device_id, secret_hash)
--      select id, '<hash>' from public.devices where device_code = 'DOTS-0001'
--      on conflict (device_id) do update set secret_hash = excluded.secret_hash;
-- 4. Put the secret itself in firmware/secrets.ini for that device and reflash.

-- ── ROLLBACK ─────────────────────────────────────────────────────────────────
-- drop table if exists public.device_secrets;
