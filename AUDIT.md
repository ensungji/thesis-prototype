# Braille D.O.T.S. — Production Health Check

**Audited:** branch `feature/added-delete` @ `884923a` (12 Oct 2026) — firmware v6.11, the full mobile app, and `supabase/functions/`.
**Not in the repo, so not audited:** database schema, RLS policies, triggers, storage policies, and the `grade-answer` and `create-teacher` edge functions. Section 3 has three SQL queries to run so those can be checked too.

Severity: **[CRITICAL]** can damage hardware or let a stranger take over · **[HIGH]** wrong data, broken flow, or a real security gap · **[MEDIUM]** fix before scaling up.

## Can I merge this branch?

**Yes.** It's better than `main` on every pillar, and merging doesn't flash devices or change the server. Merge it, then fix forward in this order:

1. **0.1 today** — it's live on your Supabase right now, merged or not.
2. **0.2** — change the Wi-Fi password.
3. **Firmware 1.1–1.4** before the next long bench test.
4. **Run the 3 SQL queries in section 3** and send me the output.
5. Everything else, top to bottom.

---

## 0. Do today

### 0.1 [CRITICAL] Anyone can reset any account's password, including the admin's
**`supabase/functions/reset-teacher-password/index.ts:12-41`** — the function never checks who is calling. Any request carrying the anon key (which is in your public repo, in `firmware/src/main.cpp:67`) and a user's UUID sets that user's password. That's a full takeover of any teacher or admin account.

**Fix** — check the caller before doing anything. Replace lines 12-15:
```ts
serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const json = (body: unknown, status: number) =>
    new Response(JSON.stringify(body), { headers: { ...cors, "Content-Type": "application/json" }, status });

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  // 1. Who is calling? (the app sends the logged-in user's token automatically)
  const token = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
  const { data: { user } } = await admin.auth.getUser(token);
  if (!user) return json({ error: "Not signed in." }, 401);

  // 2. Caller must be an active admin
  const { data: me } = await admin.from("profiles").select("role, is_active").eq("id", user.id).single();
  if (me?.role !== "admin" || me.is_active === false) return json({ error: "Admins only." }, 403);

  const { teacherId, newPassword } = await req.json();

  // 3. Target must be a teacher (an admin can't be reset through here)
  const { data: target } = await admin.from("profiles").select("role").eq("id", teacherId).single();
  if (target?.role !== "teacher") return json({ error: "Not a teacher account." }, 403);
```
Keep the rest of the function as it is, and delete the second `const admin = createClient(...)` further down. Then `supabase functions deploy reset-teacher-password`. Put the same caller check in `create-teacher`, and commit that function so it can be reviewed.

### 0.2 [HIGH] Your real Wi-Fi password is in the public git history
Commit `d28b59e` added `firmware/include/secrets.h` with the real SSID and password. "Stop tracking secrets.h" removed it from later commits, but not from history. **Change that Wi-Fi password.** That's easier than rewriting history. `firmware/.gitignore` already ignores the file from now on.

---

## Pillar 1 — Firmware safety & hardware survival

**Already fixed on this branch:** the pin logic is no longer inverted (`shiftCells`, `main.cpp:389-395`); there's a real "everything off" command (`allCoilsOff` / `clearDisplay`, 398-414, triggered by an empty chunk at 594-608); coils turn off when the WebSocket drops (683, 690) or errors (733); there's a 60 s firmware timeout (1131-1135); the device only listens for its own commands (483); buttons are debounced and fire once per press (212-229); the mic buffer is allocated once at boot (795-799).

### 1.1 [CRITICAL] The 60 s timeout restarts on every new word — there's no total heat limit
**`main.cpp:628-629`, `1131-1135`** — `energizedAt` resets with each chunk. A Timed Sequence runs up to 60 s on and 10 s off for as long as the list lasts, and Live mode has no cooldown between words at all. The app's 10 s cooldown (`[id].tsx:49`) only exists in Timed mode and only while the app is behaving. The firmware needs a per-coil heat budget that builds up across words.

Add near the other globals:
```cpp
#define HEAT_LIMIT_MS  45000UL   // per-coil budget before a forced cooldown (tune on the bench)
#define HEAT_RESUME_MS 10000UL   // allow words again once every coil is below this
#define COOL_RATE      2         // 1 ms off removes 2 ms of "heat"

uint8_t  curPats[NUM_CELLS] = {0};   // what's latched right now
uint32_t coilHeat[NUM_CELLS][6] = {};
bool cooling = false;
unsigned long lastThermal = 0;
```
In `shiftCells()`, add `memcpy(curPats, pats, NUM_CELLS);` as the first line. `publishEvent` is defined later in the file, so add `void publishEvent(const char *, int, int);` near the top. Then add:
```cpp
void thermalTick(unsigned long now)
{
  unsigned long dt = now - lastThermal;
  if (dt < 50) return;
  lastThermal = now;
  bool hot = false, cooled = true;
  for (int c = 0; c < NUM_CELLS; c++)
    for (int d = 0; d < 6; d++)
    {
      uint32_t &h = coilHeat[c][d];
      if (energized && (curPats[c] & (1 << d))) h += dt;   // counts hold as full power: conservative
      else h = h > dt * COOL_RATE ? h - dt * COOL_RATE : 0;
      if (h >= HEAT_LIMIT_MS)  hot = true;
      if (h >= HEAT_RESUME_MS) cooled = false;
    }
  if (energized && hot)
  {
    Serial.println("[SAFETY] Heat budget used — cooling down");
    clearDisplay();
    cooling = true;
    publishEvent("thermal_cutoff", 0, 0);
  }
  else if (cooling && cooled)
  {
    cooling = false;
    publishEvent("cooled", 0, 0);
  }
}
```
Call `thermalTick(now);` in `loop()` just before the 60 s check, and keep the 60 s check. In `handleCommand`, refuse new words while cooling, right before `energized = true;` (line 628):
```cpp
if (cooling) { clearDisplay(); PLAY(SND_ERROR); return; }
```

### 1.2 [HIGH] The "new word" sound keeps the coils at full power 3–4× longer
**`main.cpp:630-631`** — `showChunk()` sets PUNCHING, then `PLAY(SND_NEWWORD)` blocks the loop for about 370 ms, so the switch to hold power at 100 ms can't run. Every word gets about 370 ms at full power instead of 100 ms, with the speaker amp drawing current at the same moment, which is how you get brownouts. The fix is to play the sound first:
```cpp
  PLAY(SND_NEWWORD);   // sound first...
  energized = true;
  energizedAt = millis();
  showChunk();         // ...then pins; loop() drops to hold power 100 ms later
```

### 1.3 [HIGH] The device can't receive commands while it records and uploads an answer
**`main.cpp:858-911`, `919-920`, `671-676`, `928`**

- Recording blocks `loop()` for up to 2 s plus up to 5 s waiting for release. The upload then closes the socket on purpose and can block for up to 20 s more. During all of that, the 60 s check can't run.
- Anything sent in that window is never delivered: the end-of-word clear in Timed mode, a teacher's Pause, Finish. Missed database changes aren't replayed after reconnecting.
- If Wi-Fi dies mid-upload, `rtPaused` stays `true` forever (it's only reset on reconnect, line 642). After that, every disconnect takes the "keep the word" branch, so the turn-off-on-disconnect protection is effectively disabled.

The fix is to treat the word as answered and drop the pins before going offline (see 4.1 for the `wordId` line):
```cpp
void uploadAnswer(size_t dataBytes)
{
  String wordId = curWordId;   // 4.1 — grab it before clearDisplay() wipes it
  writeWavHeader(recBuf, dataBytes);
  clearDisplay();              // answered — don't hold coils while we can't hear the teacher
  rtPaused = true;
  wsClient.disconnect();
  ...
```
Also set `rtPaused = false;` at the end of `uploadAnswer()` and before the early `return` at line 936. The trade-off: after a wrong answer, the teacher re-sends the word if the student needs to feel it again.

### 1.4 [HIGH] Coils aren't controlled for 0.5 s on every boot and brownout
**`main.cpp:1007-1014`** — `Serial.begin` and `delay(500)` run before `pinMode(PIN_OE)`. During that time the shift registers hold random values with outputs enabled. You already lowered Wi-Fi transmit power to fight brownouts (line 1039), so this happens more often than it sounds. Make these the first lines of `setup()`:
```cpp
  pinMode(PIN_OE, OUTPUT);
  digitalWrite(PIN_OE, HIGH);   // outputs disabled before anything else
  pinMode(PIN_DATA, OUTPUT);
  pinMode(PIN_CLOCK, OUTPUT);
  pinMode(PIN_LATCH, OUTPUT);
  allCoilsOff();
  Serial.begin(115200);
```
**Hardware fix (for your teammate):** a 10 kΩ pull-up from the shared /OE line to 3.3 V. That's the only thing that covers the moment before any code runs.

Also set `SPK_TEST_ON_BOOT` to `0` (line 57) before the defense — it plays a 2-second tone on every boot.

### 1.5 [MEDIUM] The device freezes if Wi-Fi is down at power-on, and has no hotspot fallback
**`main.cpp:1057-1058`** — `while (true) delay(1000);`. Use WiFiMulti so it keeps trying both networks:
```cpp
#include <WiFiMulti.h>
WiFiMulti wifiMulti;
// setup(), replacing WiFi.begin + the wait loop + the halt:
wifiMulti.addAP(WIFI_SSID, WIFI_PASS);
wifiMulti.addAP(HOTSPOT_SSID, HOTSPOT_PASS);   // add both to secrets.h
while (wifiMulti.run(10000) != WL_CONNECTED) Serial.println("[WiFi] retrying...");
// loop(), at most every ~5 s while disconnected:
if (WiFi.status() != WL_CONNECTED) wifiMulti.run(3000);
```

### 1.6 [MEDIUM] Small firmware items
- **Logging slows the device down.** Every incoming database message is printed in full (line 698, about 600–1000 bytes at 115200 baud, roughly 50–90 ms each), and so is every outgoing one (line 458). Put both behind `#ifdef DEBUG_LOG`.
- **TLS doesn't check the server's certificate** (`setInsecure` at 751 and 926, `beginSSL` with no certificate at 1071). Fine for the defense; fix after.
- **`platformio.ini:3`** — `platform = espressif32` is unpinned. You use the legacy `driver/i2s.h`, which breaks on the newer 3.x core. Pin the platform to the version you build with now (`pio pkg list` shows it).
- **Each answer upload creates a fresh TLS client.** Keep watching your `[MEM] largest block` log line (922-923). If it shrinks over a long session, the heap is fragmenting.
- **NEXT/BACK still do nothing.** The device publishes `chunk_end`/`chunk_start` (1110, 1115), but the app never listens for them. I know that's deferred.

---

## Pillar 2 — React Native Android lifecycle & timers

**Already fixed on this branch:** the screen stays awake during a session (`[id].tsx:356-359`, `2693`); the duplicate data load on mount is gone (744-753); pause, background, blur and finish all release the devices first (518, 761, 1337, 1412); every realtime channel has a unique name and is removed on cleanup (789, 851); the live safety timer is cleared on unmount (450-457). No duplicate-subscription leaks found.

### 2.1 [MEDIUM] The Timed Sequence timer counts ticks, not time — and resume restarts the word
**`[id].tsx:1187-1243`** — the timer subtracts 1 every `setInterval(1000)`. Android delays intervals whenever the JS thread is busy, and this screen re-renders the whole 4,500-line component on every tick (4.5), so a "10 s" word runs long on a slow phone. Separately, `resumeSession` gives the current word its full duration again (1379-1389) instead of what was left.

**Fix** — drive the countdown from a deadline:
```ts
const deadlineRef = useRef<number | null>(null);
const pausedLeftMsRef = useRef<number | null>(null);

function startCountdown(sec: number) {
  deadlineRef.current = Date.now() + sec * 1000;
  timerSecondsLeftRef.current = sec;
  setTimerSecondsLeft(sec);
}
```
- Call `startCountdown(dur)` wherever the code now sets `timerSecondsLeftRef.current = dur` (lines 1158, 1204, 1227, 1314, 1387).
- Inside the interval, replace the `prev` / `nextVal` arithmetic with:
```ts
const left = Math.max(0, Math.ceil(((deadlineRef.current ?? Date.now()) - Date.now()) / 1000));
if (left !== timerSecondsLeftRef.current) {
  timerSecondsLeftRef.current = left;
  setTimerSecondsLeft(left);
}
if (left > 0) return;
// ...existing "word ended" / "cooldown ended" branches unchanged
```
- Tick every 250 ms instead of 1000.
- In `pauseSession`: `pausedLeftMsRef.current = Math.max(0, (deadlineRef.current ?? 0) - Date.now());`
- In `resumeSession`, use `startCountdown(Math.ceil((pausedLeftMsRef.current ?? dur * 1000) / 1000))` instead of the full `dur`.

This is also what the Emergency Pause in Pillar 7 needs.

### 2.2 [MEDIUM] Back, swipe and tab switches leave a live session without asking
**`[id].tsx:1853`** (header back) and **`757-765`** (blur cleanup). Leaving is now safe (devices get cleared), but one accidental back swipe pauses a running Timed Sequence. Ask first:
```ts
import { usePreventRemove } from "@react-navigation/native";
import { useNavigation } from "expo-router";
import { Alert } from "react-native";

const navigation = useNavigation();
usePreventRemove(session?.status === "in_progress", ({ data }) => {
  Alert.alert("Leave live session?", "The session will be paused and the display cleared.", [
    { text: "Stay", style: "cancel" },
    { text: "Pause & leave", style: "destructive",
      onPress: async () => { await pauseSession(true); navigation.dispatch(data.action); } },
  ]);
});
```
Tab presses don't remove the screen, so they still pause silently through the blur cleanup. That's acceptable; hide the tab bar while live if you want to block it.

### 2.3 [MEDIUM] Going to the background doesn't wait for the clear command
**`[id].tsx:518`** — `clearDevicesRef.current("session_paused")` isn't awaited, so Android can suspend JS before the insert is sent. Change it to `await clearDevicesRef.current("session_paused");`. The firmware timers (1.1) are the backstop either way.

### 2.4 [MEDIUM] Login token refresh isn't tied to the app coming back
**`lib/supabase.ts`** (unchanged from `main`) — after the phone sleeps past the 1-hour token life, the first calls on return can fail. Add Supabase's recommended snippet to `supabase.ts`:
```ts
import { AppState } from "react-native";
AppState.addEventListener("change", (state) => {
  if (state === "active") supabase.auth.startAutoRefresh();
  else supabase.auth.stopAutoRefresh();
});
```

---

## Pillar 3 — APK security, auth & access control

**Already fixed / good:** no service-role key anywhere in `mobile/`; teacher creation and password resets go through edge functions; `.env` is gitignored; recordings sit in a private bucket and play through 10-minute signed URLs (`[id].tsx:204`); pairing only claims a device that's free (`students/[id].tsx:273-278`).

**Step 1 — run these in the Supabase SQL editor and send me the output** (your RLS, triggers and storage policies aren't in the repo):
```sql
select c.relname as table_name, c.relrowsecurity as rls_on
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r' order by 1;

select schemaname, tablename, policyname, cmd, roles, qual, with_check
from pg_policies where schemaname in ('public', 'storage', 'realtime') order by 1, 2, 3;

select tgname, tgrelid::regclass as on_table, pg_get_triggerdef(oid)
from pg_trigger where not tgisinternal order by 2;
```

### 3.1 [CRITICAL] Password reset has no caller check → see 0.1

### 3.2 [HIGH — verify] A teacher can probably make themselves admin
Teachers write their own `profiles` row from the app (`login.tsx:51-53`, `dashboard.tsx:120-123` set `active_device_id`), so an UPDATE policy on "own profile" must exist. Unless it's limited to specific columns, a teacher can run `update profiles set role = 'admin' where id = auth.uid()` from their own session. The admin's `is_active` toggle is also a plain client update (`admin/index.tsx:193-197`).

**Fix** — only allow the columns teachers actually need. Role and active status then change only through an edge function using the service role:
```sql
revoke update on public.profiles from authenticated;
grant update (full_name, title, institution, active_device_id) on public.profiles to authenticated;
```
Move the admin's activate/deactivate into an edge function with the same caller check as 0.1. That breaks the current `admin/index.tsx:193-197` update until the function exists, so ship both together.

### 3.3 [HIGH] Deactivating a teacher doesn't actually lock them out
- **`login.tsx:93-97`** — if the profile fetch fails, the user is let in as a teacher.
- **`app/index.tsx:271-281`** — a saved login goes straight to the dashboard without checking `is_active`.
- Their login token stays valid; nothing on the server checks `is_active`.

**Fix:** in the deactivate edge function, also call
```ts
await admin.auth.admin.updateUserById(teacherId, { ban_duration: active ? "none" : "876000h" });
```
Make login fail closed:
```ts
if (profileError || !profile) {
  await supabase.auth.signOut();
  setError("Couldn't load your account. Check your connection and try again.");
  return;
}
```
In `app/index.tsx`, select `role, is_active` and sign out when `is_active === false`.

### 3.4 [HIGH] Anyone with the anon key can register devices and submit fake answers
**`main.cpp:748-786`, `925-943`**
- `registerDevice()` creates or updates rows in `devices` using the anon key, so your RLS lets anonymous users insert and update `devices`.
- `grade-answer` accepts any `?device=<uuid>` with the anon key. Anyone can post audio as any device, write grades into a student's record, and use up your Groq quota. Device UUIDs are easy to get, because registration returns them.

**Fix — a secret per device:**
1. Add `[platformio] extra_configs = secrets.ini` to `platformio.ini`, gitignore `secrets.ini`, and move each env's `build_flags` there with `-D DEVICE_SECRET=\"<32 random chars>\"`.
2. The firmware adds `http.addHeader("x-device-secret", DEVICE_SECRET);` to both requests.
3. SQL: `alter table devices add column secret_hash text;`, then for each device `update devices set secret_hash = encode(extensions.digest('<secret>','sha256'),'hex') where device_code = 'DOTS-0001';`
4. Move registration into a `register-device` edge function. It and `grade-answer` both check the secret first:
```ts
const secret = req.headers.get("x-device-secret") ?? "";
const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
const hash = [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const { data: dev } = await admin.from("devices")
  .select("id, paired_student_id").eq("device_code", code).eq("secret_hash", hash).maybeSingle();
if (!dev) return new Response("forbidden", { status: 403 });
```
5. Then drop the anonymous INSERT/UPDATE policies on `devices`.

### 3.5 [HIGH — verify] The pairing list may show other classes' student names, and any teacher can unpair any device
**`students/[id].tsx:231-251`** loads every device and the name of the student it's paired to. If RLS lets teachers read other teachers' `students`, every teacher sees other classes' children's names. And the "only if free" check (277) is client-side: with UPDATE on `devices`, a teacher can unpair anyone's device directly through the API.

**Fix:** pair and unpair through RPCs, and remove teachers' UPDATE on `devices`:
```sql
create or replace function public.claim_device(p_device uuid, p_student uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from students where id = p_student and teacher_id = auth.uid()) then
    raise exception 'not your student';
  end if;
  update devices set paired_student_id = null where paired_student_id = p_student;
  update devices set paired_student_id = p_student
   where id = p_device and paired_student_id is null;
  if not found then raise exception 'device already paired'; end if;
end $$;

create or replace function public.release_device(p_student uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from students where id = p_student and teacher_id = auth.uid()) then
    raise exception 'not your student';
  end if;
  update devices set paired_student_id = null where paired_student_id = p_student;
end $$;

grant execute on function public.claim_device(uuid, uuid), public.release_device(uuid) to authenticated;
```
In the device list, show "Taken" for devices paired to students that aren't yours, instead of looking up names.

### 3.6 [MEDIUM] Repo hygiene
- Commit `grade-answer`, `create-teacher`, and your SQL (as `supabase/migrations/`), so security can be reviewed.
- `supabase/.temp/` is committed; add `supabase/.temp/` to `.gitignore`.
- The recordings are children's voices. Check (query 2 above) that the `answers` bucket policy only lets a teacher read their own students' files.

---

## Pillar 4 — Real-time sync & multi-student concurrency

**Already fixed:** the UI matches answers to words by `session_word_id`, with the newest answer counting (`[id].tsx:164-181`); live attempts are de-duplicated by id (841-843); the earlier-answers fetch is capped at 200 (864).

### 4.1 [HIGH] Voice answers aren't tied to the word being answered — the 0-second boundary race
The app already puts `session_word_id` in every display command (`[id].tsx:1578`), but the firmware ignores it and uploads with `?device=` only (`main.cpp:930-931`). So `grade-answer` has to guess "the current word" at the moment the upload arrives. That's 2–5 s after the student stopped speaking, and possibly after a Timed word expired and the next one went out. An answer to Word #1 can be graded against Word #2.

**Firmware:**
```cpp
char curWordId[40] = "";

// handleCommand(), after loading the chunk:
strlcpy(curWordId, row["payload"]["session_word_id"] | "", sizeof(curWordId));

// clearDisplay():
curWordId[0] = '\0';

// uploadAnswer(): capture it first (see 1.3), then
String url = String("https://") + SUPABASE_HOST +
             "/functions/v1/grade-answer?device=" + deviceId + "&word=" + wordId;
```
**`grade-answer`:** grade against the `word` id from the query string, never "whatever is current now". If that word is no longer the session's active word, save the answer against it anyway and flag it (`needs_review = true`, or a `late` column) instead of grading it against the new word.

### 4.2 [HIGH] Clear and display commands skip devices whose status isn't "connected"
**`[id].tsx:1013-1015`** (clear), **`1565-1569`** (display), **`_layout.tsx:59`** (boot-out clear). The firmware sets `status = connected` at boot (`main.cpp:764-765`), and nothing ever sets it back to offline. If a device is ever marked anything else, it silently stops getting the "turn off" command.

**Fix:** send clear commands to every assigned student who has a paired device, whatever the status:
```ts
const deviceIds = allStudents
  .filter((s) => assignedIds.has(s.id) && s.device)
  .map((s) => s.device!.id);
```
For the green online dot, use Realtime Presence (the device announces itself on a channel) instead of a database column.

### 4.3 [HIGH] One student answer triggers a full analytics reload for the whole class
**`analytics.tsx:215-224`** — an unfiltered INSERT listener on `word_attempts` calls `loadAnalytics()` (login check + 2 queries + every attempt row) for **each** answer. Tabs keep this screen mounted during live sessions, so 20 students answering means 20 full reloads landing in random order.

**Fix** — only listen while the screen is open, and wait for answers to settle:
```ts
useFocusEffect(useCallback(() => {
  let t: ReturnType<typeof setTimeout> | null = null;
  const schedule = () => { if (t) clearTimeout(t); t = setTimeout(() => loadAnalyticsRef.current(), 1500); };
  const channel = supabase
    .channel(`analytics-realtime-${Date.now()}`)
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "word_attempts" }, schedule)
    .subscribe();
  return () => { if (t) clearTimeout(t); supabase.removeChannel(channel); };
}, []));
```
Same pattern for `dashboard.tsx` (`sessions` + `students`, any change → full reload).

### 4.4 [MEDIUM] A hand grade and a voice grade can both land for the same word
`gradeByHand` inserts a new row when there's no answer yet (`[id].tsx:895-911`). If the voice result arrives a few seconds later, that's two rows. The UI shows the newest one, but analytics counts both. Pick one rule and enforce it in the database, e.g. one row per student per word:
```sql
create unique index if not exists one_answer_per_word
  on word_attempts (session_word_id, student_id) where session_word_id is not null;
```
Then the hand grade and the voice grade both upsert on that pair. Or keep every row and have analytics count only the newest per pair (6.1 does that).

### 4.5 [MEDIUM] The whole session screen re-renders every second in Timed mode
`setTimerSecondsLeft` (1241) lives in a 4,507-line component with 40 `useState`s, so every tick re-renders everything, including both answer lists. Move the countdown into its own small component that takes `deadlineRef` from 2.1 and keeps its own state.

### 4.6 [MEDIUM] Smaller items
- **`add-word.tsx:265-302`** — `order_index = count`. Delete word #2 of 3, add a new one, and it gets the same index as #3, so the order becomes random. Use `max(order_index) + 1`, and add `unique (session_id, word)` in SQL.
- **`[id].tsx:996-1003`** — shuffle saves N separate updates. If one fails, the order is half-saved, and the error is only logged.
- **`[id].tsx:585-587`** loads every row in `devices`; **`802-805`** listens to every device update. Filter both to the assigned students' devices.

---

## Pillar 5 — Offline resilience

**Already good:** `lib/outbox.ts` is solid. It uses phone-made UUIDs so a retried insert can't duplicate, merges queued updates per row, separates network errors from real server errors, backs off retries, logs anything it gives up on, and never queues device commands. `lib/network.ts` waits for 3 failed pings before showing "offline", which handles a flaky hotspot well. Sends and launches are blocked while offline.

### 5.1 [HIGH] The outbox can lose the newest change to a row
**`outbox.ts:88`** merges a new update into the **same** queue item; **`flushOutbox` (243-244)** sends an item and then removes it. If "paused" is being sent when the teacher taps Finish, "finished" gets merged into the item mid-send. Then the item is removed and "finished" is never sent, so the session stays paused in the database.

**Fix** — in `flushOutbox`, replace lines 243-244:
```ts
const sentValues = item.values;
await send(item.table, sentValues, item.match, item.op ?? "update");
// something newer was merged in while this was sending → keep it for the next pass
if (item.values === sentValues) queue = queue.filter((q) => q !== item);
```
`enqueue` already assigns a new `values` object when it merges, so this identity check works. The retry timer picks up the kept item 3 s later.

### 5.2 [MEDIUM] A clear command that fails offline is never re-sent
**`[id].tsx:1030-1036`** — it's correctly not queued (a late word would raise dots), but a late **clear** is always safe. When the connection comes back and the session is paused or finished, send one clear to the assigned devices:
```ts
useEffect(() => subscribeOnline((online) => {
  if (online && sessionStatusRef.current !== "in_progress") clearDevicesRef.current();
}), []);
```
(Import `subscribeOnline` from `lib/network`.) The firmware 60 s and heat limits stay the backstop.

### 5.3 [MEDIUM] The device side of offline
See 1.3 (Wi-Fi dying mid-upload), 1.5 (stuck at boot, no hotspot fallback), and 4.1 (answers tied to the right word whenever they arrive).

---

## Pillar 6 — Analytics integrity & Android release

### 6.1 [HIGH] Analytics silently cap at 1,000 rows, count every attempt, and get the class average wrong
- **`analytics.tsx:148-156`** — fetches every attempt with no limit. The server returns 1,000 rows by default, so "All time" quietly becomes "the newest 1,000 answers across the whole class".
- It counts every row: retries, hand grades, voice grades, and `needs_review` answers all affect accuracy.
- **`analytics.tsx:184-185`** — students with no answers count as 0 % in the class average.
- Pronunciation vs spelling isn't stored anywhere, so it can't be reported. Add a `mode` column (`'pronounce' | 'spell'`) before the defense if you want that split.

**Fix** — do the math in the database, counting only the newest answer per student per word and skipping ones still waiting for review:
```sql
create or replace function public.teacher_student_stats(p_since timestamptz default null)
returns table (student_id uuid, full_name text, total int, correct int, avg_response_ms int)
language sql stable security invoker as $$
  with latest as (
    select distinct on (a.student_id, coalesce(a.session_word_id::text, a.id::text))
           a.student_id, a.is_correct, a.response_time_ms
    from word_attempts a
    where (p_since is null or a.attempted_at >= p_since)
      and coalesce(a.needs_review, false) = false
    order by a.student_id, coalesce(a.session_word_id::text, a.id::text), a.attempted_at desc
  )
  select s.id, s.full_name,
         count(l.student_id)::int,
         (count(*) filter (where l.is_correct))::int,
         coalesce(round(avg(l.response_time_ms) filter (where l.response_time_ms > 0)), 0)::int
  from students s
  left join latest l on l.student_id = s.id
  where s.teacher_id = auth.uid()
  group by s.id, s.full_name
  order by s.full_name;
$$;
grant execute on function public.teacher_student_stats(timestamptz) to authenticated;
```
```ts
const { data } = await supabase.rpc("teacher_student_stats", { p_since: periodFilter(period) });
const withAnswers = (data ?? []).filter((x) => x.total > 0);
const avgAccuracy = withAnswers.length
  ? Math.round(withAnswers.reduce((s, x) => s + (x.correct / x.total) * 100, 0) / withAnswers.length)
  : 0;
```
Streaks can stay computed on the phone from `students/[id].tsx`'s 50 recent answers.

### 6.2 [HIGH — verify] A production build may crash on launch
`.env` is gitignored, `eas.json` has no `environment`, and `lib/supabase.ts:15-16` and `lib/network.ts:17-18` fall back to `""`. In an EAS cloud build without environment variables, `createClient("")` throws on startup. Check with `eas env:list --environment production`. If it's empty:
```bash
eas env:create --environment production --name EXPO_PUBLIC_SUPABASE_URL --value https://nacknvkbcjxuthtycdzj.supabase.co --visibility plaintext
eas env:create --environment production --name EXPO_PUBLIC_SUPABASE_ANON_KEY --value <anon key> --visibility plaintext
```
Add `"environment": "production"` to the `production` profile in `eas.json`. For the defense APK, use the `preview` profile (it builds an APK; `production` builds an AAB for the Play Store).

### 6.3 [MEDIUM] Android build config
`android/` is generated, so permissions and Gradle settings come from `app.json` and plugins.
- **Hermes and the New Architecture are on; R8 minification is off.** So there's no ProGuard crash risk today. If you turn minification on, test the release APK on a real phone first.
- **Remove the microphone permission.** The `expo-audio` plugin (`app.json:47`) adds `RECORD_AUDIO` by default, but the phone only *plays* recordings (the device records). Add to `android` in `app.json`: `"blockedPermissions": ["android.permission.RECORD_AUDIO"]`.
- **`"scheme": "mobile"`** (`app.json:8`) is generic and can collide with other apps' deep links. Change it to e.g. `"brailledots"`.
- **Keyboard:** with `edgeToEdgeEnabled` on, the bottom-sheet inputs that use `behavior="padding"` on Android can end up behind the keyboard. Test add-student and pairing on your smallest phone.

---

## Pillar 7 — Readiness for the next two features (evaluation only)

### Word Bank selector inside Live Session — **Ready (~half a day)**
- `sendWord(word)` (`[id].tsx:1435`) is already the single entry point, with offline and validation checks, so a picker only needs to call it.
- Word-bank loading lives inside `add-word.tsx:161-220`. Pull it into a `useWordBank()` hook that both screens use, and show it as a bottom sheet in the live view.
- One thing to decide: picking a bank word that was already sent opens the "Already sent" modal (`sentWords`, 1447), which is probably what you want.

### Emergency Pause / Resume for Timed Sequence — **About a day, after a few fixes**
The base is there: `pauseSession` (`[id].tsx:1326-1342`) stops the interval, sends the clear command with a pause sound, and saves the status even offline. Before adding a dedicated emergency button:
1. **2.1** — keep the remaining time on pause, or resume restarts the word.
2. **4.2** — send the clear to every assigned device, not just "connected" ones.
3. **1.1 and 1.3** — the firmware must release on its own when commands can't reach it (mid-upload, flaky hotspot). That's what makes the button *safe*, not just fast.
4. **5.2** — re-send the clear when the connection returns.
5. **Ordering when you build it:** freeze the timer and send the clear **first**, without waiting for the database. Don't block it on `isOnline()`. Give it its own `command_type` (e.g. `emergency_stop`) and sound so students know it's not a normal pause. The firmware already treats any empty chunk as "turn everything off", so it needs no change for that.
6. **Recommended, not required:** the session screen is 4,507 lines with 40 `useState`s and about 15 mirror refs. Moving session and timer state into one `useReducer` (`idle → presenting → cooldown → paused → finished`) would make pause/resume much harder to break.

---

## Summary

| Pillar | Critical | High | Medium |
|---|---|---|---|
| 0 Do today | 0.1 | 0.2 | — |
| 1 Firmware | 1.1 | 1.2, 1.3, 1.4 | 1.5, 1.6 |
| 2 Lifecycle | — | — | 2.1, 2.2, 2.3, 2.4 |
| 3 Security | (0.1) | 3.2, 3.3, 3.4, 3.5 | 3.6 |
| 4 Concurrency | — | 4.1, 4.2, 4.3 | 4.4, 4.5, 4.6 |
| 5 Offline | — | 5.1 | 5.2, 5.3 |
| 6 Analytics/Release | — | 6.1, 6.2 | 6.3 |

None of the snippets above were compiled or run here. Test firmware changes on one cell, and app changes in a dev build, before the defense build.
