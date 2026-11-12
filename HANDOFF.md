# Braille D.O.T.S. — Handoff

Last updated: 12 Nov 2026. Repo: `github.com/ensungji/thesis-prototype`.
Companion files: `AUDIT.md` (audit findings), `TESTING.md` (test checklist), `Braille_DOTS_Test_Results.xlsx` (results + bug list).

---

## 1. Where things stand

| Area | State |
|---|---|
| **`main`** | Has the full audit work (PR #9 `fix/audit` merged). |
| **`fix/bugs`** | 7 bug fixes (B-01 to B-07), 2 firmware commits, and app changes C1–C3 (logs CSV export, 20 s break, braille preview pinned at the top). **Pushed, not merged yet.** C1 needs a new preview build. |
| **`feature/activities`** | Branched from `fix/bugs`. Activities Phases 1–6 (section 2b). **Pushed, not merged, app part not tested.** |
| **Database** | Migrations 01–14 and **16–26 run** (25 and 26 on 2026-11-12; `author_name` backfilled on the 8 existing activities, all teacher-made). Phase 1 script now has **74 checks** (needs a re-run after 25/26). 15 is covered by 21 (it adds the `graded_by` check). `LATER_…sql.txt` not run, on purpose. |
| **Edge functions** | `reset-teacher-password`, `create-teacher`, `set-teacher-active`, `register-device` deployed with the new checks; **`grade-answer` v7 deployed** (every try saved, tries, correct lock). |
| **App testing** | 22 pass, 2 partial, 15 waiting for the full device (see the Excel file). The B-01 to B-07 fixes are **not tested yet**. |
| **Hardware** | Device assembled. Dots respond, but **weak upright** and **cells 1–3 don't respond**. See section 4. |

### Still to confirm
- [ ] Wi-Fi password changed (the old one is in public git history, commit `d28b59e`).
- [ ] Supabase → Authentication → "Allow new users to sign up" is **off**.
- [x] Migration 15: no longer matters. The live table had no `graded_by` check; migration 21 adds it (auto, teacher, missed, skipped).

---

## 2. What was done

### Audit (AUDIT.md), done with Claude Code in 5 phases, merged to `main`
- **Security:** password reset and teacher creation only work for an active admin; teachers can't make themselves admin, edit other classes' grades, play other classes' recordings, take other teachers' devices, or delete shared words; new accounts are always teachers; deactivating a teacher bans the login.
- **Firmware v7.2/7.3:** per-coil heat budget, sound before pins, dots drop before an answer upload, coils controlled from the first moment of boot, Wi-Fi retry, answers tied to the word on display.
- **App:** Timed Sequence keeps the remaining time on pause, the back button asks before leaving a live session, the offline queue doesn't lose changes, analytics are calculated in the database (no 1,000-row cap), devices can move between your own students.

### Bug fixes on `fix/bugs` (not merged)
| ID | Fix |
|---|---|
| B-01 | Failed offline shuffle switches the list back to the saved order |
| B-02 | Word time is saved, shown and used everywhere (keyboard "Done" used to save 10 s) |
| B-03 | Launch Session greyed out until there's a word and a student with a device |
| B-04 | Adding a word stays on New Word, with a hint and a Shuffle button |
| B-05 | No 5-second countdown on Delete session |
| B-06 | Word Bank picker inside Live Session |
| B-07 | Missed words saved as "No answer", counted as wrong; a late voice answer replaces it; a teacher grade wins |

### Firmware on `fix/bugs`
- Latch moved **GPIO5 → GPIO21** (no more unplugging before upload).
- `PUNCH_MS` 100 → **250**, `OE_HOLD` 140 → **60** (hold power about 45% → 75%).
- Heat model counts **real power** (punch 1.0, hold about 0.76), coils **cool slower than they heat** (`COOL_RATE 0.5`), `HEAT_LIMIT_MS` **60 s** (starting value), `[HEAT]` log line for tuning.
- **Safe `pintest.cpp`:** every write clears all 5 chips, one coil at a time (0.3 s on / 1.2 s off), state 3 off after 10 s, everything off after 3 min. Builds: `state1`–`state5`.

---

## 2b. Activities (`feature/activities`, not merged)

Word lists run as a teacher-paced session. Teachers make and own them and choose to share them; the admin only oversees (read-only overview, hide / unhide) and can switch on maintenance mode. Tests: `TESTING.md`, sections "Branch feature/activities" P1–P6.

| Phase | What | State |
|---|---|---|
| **1. Database + grade-answer** | Migrations 16–22: `activities` + `activity_words` (edit lock), `duplicate_activity`, sessions type `activity` + `activity_id` / `activity_name` / `current_index`, `start_activity_session`, `answer_attempts` (every try), word_attempts `tries` + re-grade columns + `graded_by` check, grading lock trigger. grade-answer v7. | All run; **47/47** in `supabase/tests/phase1_activities_checks.sql`; v7 deployed. Device tests P1.3 not done. |
| **2. Admin screens + follow-ups** | Admin → Activities (create, edit draft, paste / Word Bank, time per word, reorder, publish, hide, duplicate, delete draft). Delete-session text, "Activity" label, voice-grade buttons hidden during a session, outbox drops lock refusals. | **Not tested on a phone.** |
| **3. Activity sessions** | New Session → Activity (published only). Previous / Next (1.5 s guard), skipped rows, pause / resume, end, resume on the same word after a crash. Answers card in every mode: heard / result / tries + ▶ latest try (60 s signed URL). | **Not tested on a phone.** |
| **4. Review + agreement** | Review screen after a session (filter, every try with ▶, re-grade any row, "Re-graded by … (was: …)"). "Done reviewing" (`sessions.reviewed_at`) and "Speech grading agreed with the teacher on X of Y voice answers (Z%)" per session and on the admin panel. | Migration 23 run. **Not tested on a phone.** |
| **5. Teacher activities** | Migration 24: `activities.shared`, RLS (creator or admin manages), `duplicate_activity` for anyone who can see it, `start_activity_session` needs shared or own. Teacher Activities (Mine / Shared) from the Sessions list; admin list shows who made each; New Session › Activity tags Mine / Shared. | Migration 24 run. Rules replaced by Phase 6. **Not tested on a phone.** |
| **6. Teachers own, admin oversees, maintenance** | Migration 25: only teachers create / edit drafts / publish / delete drafts / duplicate / start; the owner shares or un-shares a published one ("Share with all teachers"); `author_name` copied at creation and `sessions.activity_author` at start ("· by <author>"); admins read everything and hide / unhide (`hidden_at`, `hidden_by`), nothing else. Migration 26: `app_settings` (maintenance, message, started_at, set_by; Realtime; on / off logged), database guards (DT002). App: share switch, Hidden by admin, admin read-only overview + Hide confirm, Maintenance card on the admin panel, teacher banner above the tab bar, New / Create / Launch / activity edits greyed out. | Migrations 25 + 26 run. Phase 1 script 74 checks (74/74 on the stand-in), policy-check 148. **Not tested on a phone** (`TESTING.md` P6). |

**Decisions (keep these)**
- **Grading lock (all modes):** while a session isn't finished, voice grades (correct, wrong, review) can't be changed; teacher / missed / skipped rows can. Retries replace wrong / review / missed / skipped until correct by voice, which then never changes (DT001; grade-answer answers `"locked": true`). After the end, re-grade anything; the first re-grade keeps the original.
- **Deleting a session keeps the results** (`session_id` / `session_word_id` → null), so analytics don't change. Tries in `answer_attempts` go with it. Dialog: "This deletes the session. Your students' results stay in their progress."
- **Published activities can't be edited**: its teacher can only share / un-share it, an admin can only hide / unhide it; duplicate to change one. Only drafts can be deleted. Level = easy / medium / hard. Words A–Z, 1–40 letters, 5–60 s (default 20); a pasted word with anything else is dropped whole and listed.
- **Sessions copy the words** at start, so hiding / deleting an activity never touches past sessions.
- **Types in the database:** `manual` (Live), `word_list` (Timed), `activity`. The app tries `live_session` / `timed_sequence` first and falls back on the check error; keep those refused.
- **Outbox:** a queued change refused with 42501 / DT001 is dropped at once, logged (`sync_dropped`) and shown; other errors still get 5 retries.
- **Activity mode:** no timer (`duration_seconds` unused), Next is refused offline, Next / End mark unanswered students Skipped, words never shown get no rows.
- **Who owns / sees an activity (migration 25):** only teachers create, edit drafts, publish, delete drafts, duplicate and start. Every new activity and every copy is a private draft (`shared` false; a draft can never be shared). The owner turns "Share with all teachers" on / off on a published one at any time; un-sharing never touches sessions (they keep their own copy of the words and the name / author). Teachers see shared + published, and all of their own. Admins read everything and only hide / unhide published ones; `hidden` always means hidden by an admin: the owner still sees it but can't share, un-share, unhide or duplicate it, and nobody can start it. Owners can't hide their own (un-share instead; an "Archive" may come later). `author_name` is copied at creation (teachers can't read each other's profiles).
- **Maintenance mode (migration 26):** one row in `app_settings`; everyone signed in reads it, only admins change it; on / off is logged (`maintenance_on` / `maintenance_off`; a message-only change isn't). While on, signed-in non-admins can't create sessions, start a pending one (pending → in_progress / paused), call `start_activity_session`, or write `activities` / `activity_words` (SQLSTATE DT002, triggers `a_maintenance_guard`). Everything a started session needs, reading, review, students, word bank and pairing still work; admins, the service role (grade-answer) and the SQL editor are never blocked. The outbox drops DT002 refusals like 42501 / DT001. Emergency off: `update public.app_settings set maintenance = false;`
- **Agreement rule:** only reviewed sessions; a voice answer = still `auto` or re-graded from `auto`; it disagrees if re-graded to a different `is_correct`; rows still marked Review aren't counted. Same rule in `lib/review.ts` and `speech_grading_agreement()`.

---

## 3. Pin map (confirmed)

| ESP32 | Goes to |
|---|---|
| GPIO23 | DATA → 595 #1 pin 14 (start of the chain) |
| GPIO18 | CLOCK → all 595s pin 11 |
| GPIO21 | LATCH → all 595s pin 12 |
| GPIO25 | OE → all 595s pin 13 (a 10 kΩ pull-up to 3V3 is fine) |
| 3V3 | all 595s pins 16 + 10, with 0.1 µF to GND per chip |
| GND | 595 pin 8, ULN pin 9, supply GND (must be shared) |

Dots 1–6 = 595 Q2–Q7 (pins 2–7) → ULN inputs 3–8 → ULN outputs 16–11. 5 cells × 6 solenoids = 30.

---

## 4. Hardware problems found (21 Oct)

| # | Problem | Cause | Status |
|---|---|---|---|
| H1 | Nothing moved | Firmware latch was still on GPIO5; board wired to GPIO21 | **Fixed** |
| H2 | Strange voltages everywhere (0.8V, 1.4V…) | Readings taken with the 5V supply off, so no common ground | Understood: **always measure with ground shared** |
| H3 | ESP32 **3V3 pin reads 4.2V** when powered from the 5V supply | ESP32 board's regulator likely damaged, or a wiring fault on its power input. ESP32 alone on USB and PCB alone are both fine. | **Open.** Run the ESP32 on **USB only** until it's replaced. |
| H4 | Dots **only rise upside down** | Too weak: the ULN2803 loses about **1.3V**, so coils get about **4.2V** of 5.5V | **Open.** Firmware power raised; real fix = new driver or higher supply (section 5) |
| H5 | **Cells 1–3 dead**, 4–5 respond | Probably a broken **Q7′ (pin 9) → DS (pin 14)** hand-wired jumper between two 595s; data enters at the chip nearest the ESP32 header | **Open.** Check continuity hop by hop |
| H6 | Coils got very hot during testing | Old `pintest` state 3/4 only cleared the first 595; random coils stayed on at full power | **Fixed** (safe pintest) |
| H7 | Supply measures **about 5.5V**, not 5.0V | Normal for that supply | Note only |

### PCB facts (from the Gerber file)
- Single-sided board; the "top layer" connections are **hand-soldered jumper wires**.
- 595 VCC/MR net is separate from the 5V rail (no leak on the board itself).

---

## 5. Driver upgrade options (replacing the ULN2803)

Coil current is about **200–250 mA** (estimated; **measure one coil's resistance** to confirm).

| Option | Parts | Loss in driver | Coil gets (5.5V supply) | Cost | Work |
|---|---|---|---|---|---|
| **Now: ULN2803** | — | about 1.3V | about 4.2V | — | — |
| **A. TBD62083APG** (drop-in) | 1 per cell (DIP-18, same pinout) | about 0.4–0.5V | about 5.0V | about ₱55 each + shipping | Swap chips, no rewiring |
| **B. AO3400A per coil** (new PCB) | AO3400A + Schottky (1N5819/SS14) + 10 kΩ gate pull-down, ×30 | about 0.01V | about 5.5V | about ₱150–250 total | New PCB, 90 small parts (or fab assembly) |
| **C. Raise the supply** (no new driver) | Supply V.ADJ knob, or 9–12V adapter + LM2596 buck set to about 6.3V | stays 1.3V | about 5.0V | free–₱200 | Quick; keep the ESP32 on USB; don't exceed about 6.5V |

- **Expected gain with A:** about **40% more push force**, and the driver chip runs much cooler (about 0.7W vs 1.6W with 6 dots up).
- **Buy A from LCSC (C114143).** **Do not buy TD62083APG** (no "B"): it's the old Darlington with the same loss.
- **Not suitable:** TPL7407L (needs 8.5V+ on COM), TPIC6B595 (needs 5V logic, only 150 mA).
- **Optional for a new PCB:** a temperature sensor (DS18B20 or 10k NTC) near the solenoids for a hard heat cutoff; a replacement ESP32 board.
- **Firmware note:** after a driver upgrade, coils get full voltage, so `OE_HOLD` can go back toward 140 (less hold power, less heat). Re-tune `HEAT_LIMIT_MS`.

---

## 6. Next steps (in order)

1. **Hardware, cells 1–3:** power off, Ω mode, check pin 9 → pin 14 between each pair of 595s in chain order; fix the broken jumper.
2. **Hardware, ESP32 power:** run on USB. Plan a replacement ESP32 board or a separate 5V USB adapter.
3. **Map test:** `pio run -e state5 -t upload`, supply ON, note which physical dot rises for each `cell X dot Y` line. Fix cell order or dot mapping if needed.
4. **Force:** with the device upright, check that pins don't rub in the top plate; then decide on option A, B or C.
5. **Heat tuning:** once dots lift upright, follow the `HEAT_LIMIT_MS` steps in `TESTING.md` 1.1 (needs a thermometer or IR gun).
6. **App:** test B-01 to B-07 and C1–C3 on the phone (preview APK), record results in the Excel file, then merge `fix/bugs` into `main`.
6a. **Activities:** re-run `TESTING.md` P1.1 (74 checks), then a new preview APK from `feature/activities` and P1.3, P2–P6. Merge after `fix/bugs` (the branch contains it).
6b. **Firmware team (later):** setup hold about 10 s with a warning sound, error-beep rate limit, setup password in `secrets.ini`, port the v7.1b chunk navigation into v7.3 (**don't flash v7.1b**, it lacks the heat budget and boot safety), then unlimited retries with dots dropping on a correct answer.
7. **Before the defense:** preview APK build (`eas build --profile preview --platform android`, with `EXPO_PUBLIC_*` env vars set for the preview environment), Round 3 device tests in `TESTING.md`.

### Later (not needed for the defense)
- Per-device secrets + the `LATER_…sql.txt` migration (AUDIT 3.4).
- Certificate checking for the ESP32's HTTPS connections.

---

## 7. Working with Claude Code
- In Claude Code, start fresh with `/clear`, then say: "Read HANDOFF.md, AUDIT.md and TESTING.md first."
- Work on a branch, one commit per change; SQL goes in `supabase/migrations/` and is **reviewed before running** in the SQL Editor (one file at a time, never `supabase db push` while a "run later" file is in the folder).
- Merging: PR on GitHub; tick "Merge without waiting for requirements" (owner bypass) if review is required.
