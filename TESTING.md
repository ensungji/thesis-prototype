# Braille D.O.T.S. — Test checklist for the AUDIT.md fixes

Branch `fix/audit`. One section per audit finding that was fixed. Each step says
what to do (**Do**) and what you should see if it works (**Expect**). If a step
fails, note the section number and step, and paste what you saw.

Findings not listed here were not changed: 0.2 (change the Wi-Fi password, your
job), 1.5 (already fixed by commit 641d906 before the audit work), 6.2 (EAS
environment, your job), Pillar 7 (evaluation only).

---

## A. Automated checks (already run, all passing)

| Check | Command | Result |
|---|---|---|
| App types | `cd mobile && npx tsc --noEmit` | pass |
| App lint | `cd mobile && npx expo lint` | pass (0 errors, 12 old warnings) |
| Firmware | `cd firmware && pio run -e dots1` (also dots2, dots3) | pass |
| Edge functions | `npx deno check -q supabase/functions/**/*.ts` (all 6 files) | pass |
| Migrations + policies | `cd supabase/tests/policy-check && npm install && npm run check` | 14 migration runs + 38 behaviour checks pass |

The policy check runs every migration against a stand-in schema in an
in-memory Postgres. It never touches your database. It proves the SQL runs and
the rules behave as intended on that stand-in, not on your real tables, so the
hand tests below still matter.

---

## B. Setup before the hand tests

1. Run the migrations in the order from Phase 4 (01–07, 09–13, then 08 after
   the new app is installed). Do **not** run `LATER_…sql.txt`.
2. Deploy the functions:
   ```
   npx supabase functions deploy reset-teacher-password
   npx supabase functions deploy create-teacher
   npx supabase functions deploy grade-answer
   npx supabase functions deploy register-device
   npx supabase functions deploy set-teacher-active
   ```
3. Flash one device with the current firmware (`pio run -e dots1 -t upload`,
   GPIO5 unplugged during upload). No `secrets.ini` yet. Open the serial
   monitor: `pio device monitor`. The banner must say **v7.3**.
4. Install a new app build (EAS dev or preview build, not a JS reload: the
   permission and scheme changes are native).
5. Accounts: one admin, two teachers (**Teacher A**, **Teacher B**). Teacher A
   has two students (call them **Ana** and **Ben**); Teacher B has one
   (**Bea**). A student can only join a session with a paired device, so pair:
   Ana → DOTS-0001 (the flashed one, on the bench), Ben → DOTS-0002, Bea →
   DOTS-0003. DOTS-0002 and 0003 can stay switched off; they only need to have
   booted once so they exist in the devices table.
6. For the security tests (section S), open Git Bash and set these once:
   ```bash
   URL=https://nacknvkbcjxuthtycdzj.supabase.co
   ANON='<anon key from mobile/.env>'
   token() { curl -s "$URL/auth/v1/token?grant_type=password" -H "apikey: $ANON" \
     -H "Content-Type: application/json" -d "{\"email\":\"$1\",\"password\":\"$2\"}" \
     | sed -n 's/.*"access_token":"\([^"]*\)".*/\1/p'; }
   A=$(token teacherA@example.com 'passwordA')
   B=$(token teacherB@example.com 'passwordB')
   ADMIN=$(token admin@example.com 'passwordAdmin')
   echo ${#A} ${#B} ${#ADMIN}   # three numbers well above 100 = all logged in
   ```
   Get user ids when a step needs them from the SQL editor:
   `select id, email, role from profiles;`

Braille patterns used below: **C** = dots 1+4, **A** = dot 1, **T** = dots
2+3+4+5. So **CAT** on three cells raises 2 + 1 + 4 = 7 pins.

---

## Firmware (one cell, serial monitor open)

### 1.4 Coils are controlled from the first moment of boot
1. **Do:** Power the device off. Watch the cells closely and power it on.
   **Expect:** No pin moves at any point during boot, including the first
   second. The serial log starts with `=== BRAILLE D.O.T.S. v7.3`.
2. **Do:** Press the ESP32's reset button 5 times, a few seconds apart.
   **Expect:** No pin twitches on any reset.
3. **Do:** Listen during boot.
   **Expect:** No 2-second test tone (it's off), only the ready sound once
   Realtime connects.
4. Hardware item for your teammate: 10 kΩ pull-up from /OE to 3.3 V. Without
   it, a twitch in the few microseconds before the code runs is still possible.

### 1.2 "New word" sound plays before the pins rise
1. **Do:** Teacher A starts a Live session with Ana and sends **CAT**.
   **Expect:** You hear the new-word chime first, and the pins rise only after
   it ends (about 0.4 s later). Not at the same time.
2. **Expect (serial):** `[CMD] Chunk received: 'CAT' (3 letters)`, then
   `[SHOW] 'CAT' on 3 cell(s)`, in that order, after the chime.
3. **Expect (cells):** Cell 1 dots 1+4, cell 2 dot 1, cell 3 dots 2+3+4+5. All
   others down.

### Firmware 60 s timeout (backstop when the app can't clear)
1. **Do:** Send **CAT** (Live). As soon as the pins are up, turn on airplane
   mode on the phone so the app can't send a clear.
2. **Expect:** At 60 s after the word went up, the pins drop by themselves.
   Serial: `[SAFETY] 60s firmware timeout` then `[SAFETY] All coils OFF`.
3. **Do:** Turn airplane mode off.
   **Expect:** The app catches up (see 5.2). Nothing raises the pins again.

### 1.1 Heat limit across words
Uses the defaults (limit 60 s of "heat", hold counted at its real power
≈ 0.76, resume below 10 s, cooling at half the heating rate). Same word each
time so the same coils heat up. Serial prints `[HEAT] hottest coil …` every
5 s while any coil is warm.
1. **Do:** Live session. Send **CAT**. Don't clear it; let it auto-clear at 60 s.
   **Expect:** `[HEAT]` climbs to about 46 s.
2. **Do:** Within 2 s of the auto-clear, send **CAT** again (tap "Re-send
   Anyway" when asked).
   **Expect:** The pins rise normally.
3. **Expect:** About 20 s later the pins drop by themselves. Serial:
   `[SAFETY] Heat budget used up - cooling down`.
4. **Do:** Immediately send any word.
   **Expect:** The pins stay down and the device plays the error sound.
   Serial: `[SAFETY] Cooling down - word refused`.
5. **Expect:** About 100 s after step 3, serial:
   `[SAFETY] Cooled down - words allowed again`.
6. **Do:** Send **CAT** again.
   **Expect:** It shows normally.
7. **Do (tuning):** If the coils felt hot during step 2, lower `HEAT_LIMIT_MS`
   in `main.cpp` and repeat. Note the value that's safe for your coils.

### 1.3 Wi-Fi unplugged mid-word: dots drop
1. **Do:** Send **CAT**. While the pins are up, switch off the Wi-Fi router or
   hotspot the device uses.
2. **Expect:** Within a few seconds the pins drop. Serial:
   `[RT] Disconnected. Will retry...` and `[SAFETY] All coils OFF`.
   They must drop no later than 60 s in any case.
3. **Do:** Leave Wi-Fi off for 2 minutes.
   **Expect:** Serial `[WiFi] Still lost after 2 min — restarting`, and the
   device reboots with no pins moving (1.4).
4. **Do:** Turn the Wi-Fi back on.
   **Expect:** The device reconnects and plays the ready sound. No pins rise
   until a word is sent.

### 1.3 + 4.1 Answer upload: dots drop, the right word is graded
1. **Do:** Live session, send **CAT** to Ana's device.
2. **Do:** Hold ANSWER. After the "listening" beep, say "cat", then release.
   **Expect:** The pins drop right after the beep, before you speak. Serial
   `[MIC] Recording + streaming... (release ANSWER to stop)` then
   `[SAFETY] All coils OFF`.
3. **Expect:** After release, a "checking" sound, then the correct sound.
   Serial `[ANS] HTTP 200` and `[ANS] >>> correct  (heard: "cat")`.
4. **Expect (app):** Ana's answer for CAT appears as correct in the session's
   answer list within a few seconds.
5. **Expect (pins stay down):** After the device reconnects (about 1–3 s), the
   pins do **not** rise again on their own (approved: no auto re-send after an
   answer). The app shows no "Re-sent" toast.
6. **Do (SQL editor):**
   ```sql
   select a.word, a.is_correct, a.needs_review, sw.word as word_row, a.session_word_id
   from word_attempts a join session_words sw on sw.id = a.session_word_id
   order by a.attempted_at desc limit 3;
   ```
   **Expect:** The newest row has `word` CAT and `word_row` CAT (the
   session_word_id points at the CAT row).
7. **Do (late answer):** Timed Sequence with two words of 10 s each, e.g.
   **CAT** then **DOG**. During CAT, hold ANSWER and keep talking until CAT's
   time is over (the app clears and goes to the break), then release and say
   "cat".
   **Expect:** Device plays the **review** sound. In the app the answer is
   listed against **CAT** as needs review, never against DOG. Admin → Logs
   shows `answer_graded` with `late: true`.

### 1.6 Logging and platform pin
1. **Do:** Watch the serial log during a session.
   **Expect:** No full JSON lines starting with `→ Supabase:` or
   `← Supabase:` (only short `[RT]`, `[CMD]` lines).
2. **Do:** Uncomment `#define DEBUG_LOG` in `main.cpp`, build and flash.
   **Expect:** The full JSON lines appear again. Comment it out again after.
3. **Do (Git Bash):** `cd firmware && PYTHONIOENCODING=utf-8 pio pkg list -e dots1`
   **Expect:** `Platform espressif32 @ 7.0.1 (required: espressif32 @ 7.0.1)`.

### 3.4 Per-device secret (optional until you lock down anon access)
Do this on one device first.
1. **Do:** Make a secret and its hash, and store the hash (steps 1–3 in
   `supabase/migrations/20261019121300_device_secrets.sql`).
2. **Do:** `copy firmware\secrets.ini.example firmware\secrets.ini`, put the
   secret on the `dots1` line, build and flash.
   **Expect:** Serial `[REG] HTTP 200: [{"id":"...","paired_student_id":...}]`.
   The device works as before.
3. **Do:** Answer a word.
   **Expect:** Graded normally (`[ANS] HTTP 200`).
4. **Do:** Change one character of the secret in `secrets.ini`, build, flash.
   **Expect:** Serial `[REG] HTTP 403` repeating every 5 s; Admin → Logs shows
   `device_rejected` with "wrong device secret". Put the right secret back.
5. **Do:** `git status`
   **Expect:** `secrets.ini` is **not** listed (it's ignored).

---

## App

### 2.1 Timed Sequence keeps the remaining time on pause / resume
1. **Do:** Timed Sequence with 2 words, 30 s each. Launch. Start a stopwatch
   when the first word's pins rise.
2. **Do:** When the app shows about **20s** left, tap **Pause Timer**.
   **Expect:** The countdown freezes at about 20s. The pins drop.
3. **Do:** Wait 30 s. Tap **Resume Timer**.
   **Expect:** The countdown continues from about 20s (not 30s). The same word
   is sent again and the pins rise.
4. **Expect:** The word ends when the countdown hits 0. Stopwatch total minus
   the 30 s pause is about 30 s (within 1–2 s).
5. **Do:** Repeat steps 2–3 with the session's **Pause** button (the one that
   pauses the whole session) instead of Pause Timer, then **Resume**.
   **Expect:** Same: it resumes with the time that was left.
6. **Do:** Pause during the 10 s **Student Break**, wait, resume.
   **Expect:** The break continues with its remaining time; no word is sent
   during the break. After the break, word 2 starts with its full 30 s.
7. **Do:** On your slowest phone, run a 60 s word and time it.
   **Expect:** It ends within about 1 s of 60 s on the stopwatch.

### 2.2 Back button asks before leaving a live session
1. **Do:** During a running session, press Android Back (or swipe back, or the
   header back arrow).
   **Expect:** Alert "Leave live session?" with **Stay** and **Pause & leave**.
2. **Do:** Tap **Stay**.
   **Expect:** You stay; the session keeps running; pins unchanged.
3. **Do:** Press Back again, tap **Pause & leave**.
   **Expect:** The device plays the pause sound, pins drop, the app leaves the
   screen. Reopen the session: it shows **Paused**.
4. **Do:** Press Back on a session that is pending, paused or finished.
   **Expect:** No alert; it just goes back.

### 2.3 Going to the background clears the device
1. **Do:** Running Live session with **CAT** up. Press the phone's Home button.
   **Expect:** Within a second or two the device plays the pause sound and the
   pins drop. Reopen the app: the session is Paused.

### 2.4 Login survives a long sleep
1. **Do:** Log in, then leave the phone locked for more than 1 hour.
2. **Do:** Unlock, open the app, open a session and refresh.
   **Expect:** Data loads; no login error and no bounce to the login screen.

### 4.2 Clears reach devices marked offline
1. **Do:** Live session, send **CAT**. In the SQL editor:
   `update devices set status = 'offline' where device_code = 'DOTS-0001';`
2. **Do:** In the app tap **Pause** (or Clear Display).
   **Expect:** The pins drop anyway.
3. **Do:** Resume and send a word.
   **Expect:** The word reaches the device although the database said offline.
4. **Do:** Put the status back:
   `update devices set status = 'connected' where device_code = 'DOTS-0001';`

### 4.3 Analytics and dashboard don't reload on every answer
1. **Do:** Open **Analytics**. Have the device answer one word.
   **Expect:** The numbers update about 1.5 s after the answer, once.
2. **Do:** Switch to another tab. Answer two words. Switch back to Analytics.
   **Expect:** The numbers are up to date as soon as you return.
3. **Do:** On the **Dashboard**, change a session (start / finish one on
   another phone or in the SQL editor).
   **Expect:** The dashboard updates about 1.5 s later.

### 4.4 One answer per student per word
1. **Do:** Live session, send **CAT**. Tap **Mark correct** (✓) for Ana before
   she answers. Then have her answer by voice, saying "dog".
   **Expect:** Ana has **one** CAT entry. It stays **correct** (the teacher's
   grade stands); the transcript "dog" and the recording are added to it.
2. **Do:** Send **SUN**. Ana answers "sun" by voice. The pins drop (1.3), so
   tap **Pause** then **Resume**: that re-sends the same SUN. Ana answers again,
   saying "dog".
   **Expect:** One SUN entry, showing the **newest** voice result (wrong,
   heard "dog"). (Re-send Anyway would not test this: it makes a new SUN word.)
3. **Do (SQL):**
   ```sql
   select session_word_id, student_id, count(*) from word_attempts
   where session_word_id is not null group by 1, 2 having count(*) > 1;
   ```
   **Expect:** No rows.

### 4.5 The countdown doesn't re-render the whole screen
1. **Do:** Run a Timed Sequence with a long answer list visible (scroll the
   answers while the timer runs).
   **Expect:** Scrolling stays smooth; the list doesn't flicker or jump each
   second. (Optional: React DevTools "Highlight updates" shows only the timer
   card updating each second.)

### 4.6 Word order, shuffle, device loading
1. **Do:** Timed Sequence: add **CAT**, **DOG**, **SUN**. Delete DOG. Add
   **BEE**.
   **Expect:** Order CAT, SUN, BEE, and it stays that way after leaving and
   reopening the session.
2. **Do:** Tap **Shuffle**. Leave and reopen the session.
   **Expect:** The shuffled order is kept exactly.
3. **Do:** Turn on airplane mode, tap Shuffle.
   **Expect:** Toast "Couldn't save the new order"; after reconnecting and
   reopening, the order is the one saved before (not half-shuffled).
4. **Do:** Live session with Teacher A while Teacher B pairs/unpairs their own
   device.
   **Expect:** Teacher A's session screen doesn't change or reload.

### 5.1 Offline: queued grades sync once, Finish isn't lost
1. **Do:** Live session with Ana and Ben. Send **CAT**. Turn on airplane mode.
   **Expect:** After a few seconds, a red **Offline** banner at the top.
2. **Do:** Tap ✓ for Ana and ✗ for Ben. Then tap **Pause**, then **Finish
   Session**.
   **Expect:** The banner shows the number of changes waiting (3 or more).
   The screen shows Finished.
3. **Do:** Turn airplane mode off.
   **Expect:** A green **Back online** banner while it syncs, then it hides.
4. **Do (SQL):**
   ```sql
   select status, finished_at from sessions where id = '<session id>';
   select student_id, is_correct, graded_by, count(*) over (partition by student_id)
   from word_attempts where session_id = '<session id>';
   ```
   **Expect:** status **finished** with a finished_at (not paused). One row for
   Ana (correct) and one for Ben (wrong), each count 1, `graded_by` teacher.
5. **Do:** Repeat, but tap Finish while the banner says "syncing" (turn
   airplane mode off and tap Finish right away).
   **Expect:** Status still ends as **finished**.

### 5.2 A failed clear is re-sent when the phone comes back
1. **Do:** Live session, send **CAT**. Turn on airplane mode. Tap **Pause**.
   **Expect:** The pins stay up (the clear couldn't be sent).
2. **Do:** Turn airplane mode off within 30 s.
   **Expect:** Within a few seconds of the banner going green, the pins drop
   (before the device's own 60 s timer).

### Device presence: no automatic re-send right after an answer
Covered in "1.3 + 4.1" step 5. Also:
1. **Do:** Live session, send **CAT**, then power the device off and on again
   (without answering).
   **Expect:** When it's back, the app shows a toast "DOTS-0001 is back
   online" with "Re-sent "CAT" to Ana's device.", and the pins rise again.
   (Re-send still happens after a power cut, just not after an answer.)

### 6.1 Analytics numbers match a hand count
Use a fresh test teacher so earlier tests don't mix in. As admin, create
**Teacher C**. Teacher A unpairs DOTS-0001 (Ana) and DOTS-0002 (Ben). Teacher C
adds two students, **Cara** and **Dan**, and pairs DOTS-0001 to Cara and
DOTS-0002 to Dan. Use the ✓ / ✗ buttons so the grades are exact.
1. **Do:** Teacher C runs a Live session with Cara and Dan, in this order:
   - Send **CAT**, tap ✓ for Cara.
   - Send **DOG**, tap ✗ for Cara.
   - Send **SUN**, tap ✓ for Cara, then change it to ✗ (same word, newest grade).
   - Send **BEE**. Cara holds ANSWER and stays silent for 2 s (the device
     plays the review sound: BEE is "needs review"). Leave BEE on screen.
   - Dan answers nothing.
2. **Hand count:** one answer per word, needs-review skipped.
   Cara = CAT ✓, DOG ✗, SUN ✗ → **1 of 3 correct = 33 %**. BEE doesn't count.
   Dan has no answers, so the class average is Cara's alone: **33 %** (not
   17 %). Total words = **3**. Cara's streak = **0** (newest counted is ✗).
3. **Do:** Without finishing, switch to the Analytics tab, **All time**.
   **Expect:** Cara 1/3 correct, 33 %, no streak shown. Dan 0/0. Class average
   33 %. Total words 3.
4. **Do:** Back in the session, while BEE is still the current word, tap ✓ for
   Cara. Return to Analytics.
   **Expect:** Cara 2/4, 50 %, streak 1 (BEE is the newest and correct).
   Class average 50 %. Total words 4.
5. **Do (SQL editor cross-check, run all four lines together):**
   ```sql
   begin;
   select set_config('request.jwt.claim.sub', '<Teacher C id>', true);
   select * from teacher_student_stats();
   commit;
   ```
   **Expect:** The same numbers as the screen.
6. **Do:** Finish the session. Move DOTS-0001 and DOTS-0002 back to Ana and
   Ben (Teacher C unpairs, Teacher A pairs).

### 6.3 Android config
1. **Do:** Android Settings → Apps → Braille DOTS → Permissions.
   **Expect:** No Microphone permission listed.
2. **Do:** `adb shell am start -a android.intent.action.VIEW -d "brailledots://"`
   **Expect:** The app opens.
3. **Do:** On your smallest phone, open Add Student and the pairing sheet and
   tap the text fields.
   **Expect:** The keyboard doesn't cover the field you're typing in.

---

## Security and server (section S)

### 0.1 reset-teacher-password (and the same check in create-teacher, set-teacher-active)
1. **Do:** Without any login (anon key only):
   ```bash
   curl -s -w ' HTTP %{http_code}\n' -X POST "$URL/functions/v1/reset-teacher-password" \
     -H "Authorization: Bearer $ANON" -H "Content-Type: application/json" \
     -d '{"teacherId":"<Teacher B id>","newPassword":"12345678"}'
   ```
   **Expect:** `{"error":"Not signed in."} HTTP 401`. (No login at all is 401;
   a logged-in non-admin is 403, next step.)
2. **Do:** Same command with `-H "Authorization: Bearer $A"` (Teacher A).
   **Expect:** `{"error":"Admins only."} HTTP 403`. Teacher B can still log in
   with their old password.
3. **Do:** With `$ADMIN`, and `teacherId` = the admin's own id.
   **Expect:** `{"error":"Not a teacher account."} HTTP 403`.
4. **Do:** In the app as admin, reset Teacher B's password.
   **Expect:** Success; Teacher B logs in with the new password.
5. **Do:** Steps 1–2 against `create-teacher` with body
   `{"email":"x@example.com","password":"12345678","full_name":"X"}`.
   **Expect:** 401, then 403; no account x@example.com is created.

### 3.2 A teacher can't change their own role or active status
1. **Do:**
   ```bash
   curl -s -w ' HTTP %{http_code}\n' -X PATCH "$URL/rest/v1/profiles?id=eq.<Teacher A id>" \
     -H "apikey: $ANON" -H "Authorization: Bearer $A" -H "Content-Type: application/json" \
     -d '{"role":"admin"}'
   ```
   **Expect:** HTTP 403 with "Only an admin can change role or active status".
2. **Do:** Same with `-d '{"is_active":true}'` and with `-d '{"is_active":false}'`.
   **Expect:** Same 403 both times.
3. **Do:** Same with `-d '{"full_name":"Teacher A"}'`.
   **Expect:** HTTP 204 (allowed).
4. **Do (SQL):** `select role, is_active from profiles where id = '<Teacher A id>';`
   **Expect:** still `teacher`, `true`.
5. **Do:** Log in as Teacher A on a phone (writes active_device_id).
   **Expect:** Login works normally.

### 3.2 / review 2: new accounts are always teachers
1. **Do:** As admin, create a teacher in the app.
   **Expect:** Works; `select role from profiles where email = '<new>'` is
   `teacher`.
2. **Do:** Check Auth → Settings: "Allow new users to sign up" is off.

### 3.3 Deactivating a teacher locks them out
1. **Do:** Teacher B is logged in on a phone. As admin, deactivate Teacher B.
   **Expect:** Toast "Teacher deactivated". Admin list shows Inactive.
2. **Do:** On Teacher B's phone, close the app fully and reopen it.
   **Expect:** It goes to the welcome / login screen, not the dashboard.
3. **Do:** Try to log in as Teacher B.
   **Expect:** An error ("User is banned" or "Your account has been
   deactivated"); no way in.
4. **Do:** Reactivate Teacher B as admin, log in again.
   **Expect:** Works.
(The other 3.3 change, refusing a login whose profile can't be loaded, can't
be triggered reliably by hand: it needs the sign-in to succeed and the very
next request to fail.)

### 3.5 / review 5: device pairing
1. **Do:** Teacher A opens Ana → Pair device.
   **Expect:** DOTS-0001 shows "Paired to this student". DOTS-0002 shows
   "With Ben — tap to move". DOTS-0003 (Teacher B's) shows **Taken**, with no
   student name.
2. **Do:** Tap DOTS-0003.
   **Expect:** Nothing happens (it can't be picked).
3. **Do:** Open Ben → Pair device, tap DOTS-0001 ("With Ana — tap to move").
   **Expect:** DOTS-0001 plays the paired sound and is now Ben's. Ana has no
   device. Reopen the list: DOTS-0002 (Ben's old one) now shows **Available**.
4. **Do:** Put it back: Ana → tap DOTS-0001 ("With Ben — tap to move"), then
   Ben → tap DOTS-0002 (Available).
   **Expect:** Ana has DOTS-0001 and Ben has DOTS-0002 again.
5. **Do:** Unpair Ana's device, then pair it again.
   **Expect:** Unpaired sound, then paired sound; both stick after reopening.
6. **Do (API, after migration 08):**
   ```bash
   curl -s "$URL/rest/v1/devices?select=device_code,paired_student_id" -H "apikey: $ANON" -H "Authorization: Bearer $A"
   curl -s -X PATCH "$URL/rest/v1/devices?device_code=eq.<Teacher B's device>" -H "apikey: $ANON" \
     -H "Authorization: Bearer $A" -H "Content-Type: application/json" -H "Prefer: return=representation" \
     -d '{"paired_student_id":null}'
   ```
   **Expect:** The list has only Teacher A's devices and free devices. The
   PATCH returns `[]` (nothing changed). Teacher B's device is still paired.
7. **Do:** Watch the green online dots in a session while turning a device on
   and off.
   **Expect:** They still change (status is written through the new function).

### Review 3: answers can't be written for another class
1. **Do:**
   ```bash
   curl -s -X PATCH "$URL/rest/v1/word_attempts?student_id=eq.<Bea id>" -H "apikey: $ANON" \
     -H "Authorization: Bearer $A" -H "Content-Type: application/json" -H "Prefer: return=representation" \
     -d '{"is_correct":false}'
   ```
   **Expect:** `[]`. Bea's answers are unchanged.
2. **Do:** Teacher A grades and overrides grades for their own students in a
   session.
   **Expect:** Works (covered in 4.4 and 5.1).

### Review 4: recordings are private to each teacher
1. **Do (SQL):** `select audio_path from word_attempts where student_id = '<Ana id>' and audio_path is not null limit 1;`
2. **Do:**
   ```bash
   curl -s -X POST "$URL/storage/v1/object/sign/answers/<that audio_path>" -H "apikey: $ANON" \
     -H "Authorization: Bearer $B" -H "Content-Type: application/json" -d '{"expiresIn":60}'
   ```
   **Expect:** An error (object not found), no `signedURL`.
3. **Do:** Same with `$A`.
   **Expect:** A `signedURL`. In the app, Teacher A can play Ana's recording.

### Review 6: shared word bank words are read-only
1. **Do:**
   ```bash
   curl -s -X DELETE "$URL/rest/v1/word_library?teacher_id=is.null" -H "apikey: $ANON" \
     -H "Authorization: Bearer $A" -H "Prefer: return=representation"
   ```
   **Expect:** `[]`; the shared words are still there.
2. **Do:** In the app, add and delete one of your own word bank words; in
   add-word, the shared words are still offered.
   **Expect:** All works.

### Review 7: you can only assign your own students
1. **Do:**
   ```bash
   curl -s -w ' HTTP %{http_code}\n' -X POST "$URL/rest/v1/session_students" -H "apikey: $ANON" \
     -H "Authorization: Bearer $A" -H "Content-Type: application/json" \
     -d '{"session_id":"<a Teacher A session id>","student_id":"<Bea id>"}'
   ```
   **Expect:** HTTP 403 (row-level security).
2. **Do:** Assign Ana to a session in the app.
   **Expect:** Works.

### Review 8: a deactivated admin isn't an admin
1. **Do (SQL):** with a second, spare admin account:
   `update profiles set is_active = false where email = '<spare admin>';`
2. **Do:** Log in as the spare admin and call reset-teacher-password (0.1
   step 2 with their token).
   **Expect:** `Admins only.` HTTP 403. Set `is_active = true` again after.

### 3.6 Repo hygiene
1. **Do:** `git status` after running any `supabase` command.
   **Expect:** Nothing under `supabase/.temp/` is listed.
2. **Do:** `git ls-files | findstr /i "secrets.h secrets.ini .env"`
   **Expect:** Only `firmware/secrets.ini.example`.
