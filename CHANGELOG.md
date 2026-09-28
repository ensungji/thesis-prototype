# Changelog

All notable changes to the BrailleEd thesis prototype are documented here.
Format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [Unreleased]

---

## [2026-09-28] — Timed Sequence Playback Engine, Hardware Safety & Educational Polish

### Added

#### Timed Sequence Auto-Cycle Playback Engine (`sessions/[id].tsx`)
- **Automated Sequence Playback**: Built an interval-based auto-cycle engine that holds each word for its designated duration, displaying an active countdown timer and visual progress track.
- **Simplified Controls**: Removed manual "Previous" and "Next/Skip" controls in active Timed Sequences to enforce strictly automated lesson pacing. Only the primary "Pause Timer" / "Resume Timer" button is retained.
- **Hardware Coil Release on Pause**: Pausing the sequence timer immediately triggers `clearDevices()` to drop solenoid coils and prevent overheating while the teacher addresses the classroom. Resuming re-broadcasts the active word only if not in a cooldown state.

#### Hardware Safety Limits — Solenoid Burnout Prevention (`lib/session-timer.ts`, `sessions/[id].tsx`, `sessions/add-word.tsx`)
- **Strict 5s – 60s Duration Cap**: Implemented `clampDuration()` enforcing a hard minimum of 5 seconds and maximum of 60 seconds per word (`MIN_WORD_DURATION_SEC = 5`, `MAX_WORD_DURATION_SEC = 60`) to physically prevent solenoid burnout on physical Braille displays.
- **Per-Word Duration Steppers**: Added interactive `+` / `-` stepper buttons (5-second increments) to each word in the Timed Sequence builder and session setup views.
- **Local Storage Cache Fallback**: Added `loadWordDurations` and `saveWordDurations` with `AsyncStorage` persistence, preserving custom word durations across app restarts even when database schema migrations are pending.
- **Visual Safety Badges**: Displayed "5s – 60s limit" and "Max 60s coil safe" indicators in the builder and active playback views.

#### 10-Second Hardware Cooldown & Classroom Break (`sessions/[id].tsx`)
- **Automatic Solenoid De-energizing**: When a word's active timer hits 0, `clearDevices()` is immediately invoked to release all solenoid pins on connected devices.
- **Mandatory 10s Cooldown State**: If subsequent words remain in the sequence, the engine enters a mandatory 10-second breather phase (`COOLDOWN_DURATION_SEC = 10`).
- **Dedicated Cooldown Card UI**: Switches the hero display to a themed break card with a dedicated 10-second progress bar, countdown counter, and "Display Cleared" badge.
- **Automatic Next-Word Broadcast**: When the 10 seconds conclude, the engine automatically advances to the next word index and broadcasts it to student devices.
- **De-energized Device Display**: The Braille preview component clears all pins and informs the teacher that pins are lowered during the break.

#### Auto-Finish on Final Word Completion (`sessions/[id].tsx`)
- **Zero-Cooldown Final Transition**: When the final word in the sequence completes its active duration (no cooldown needed after the last word), the engine immediately calls `executeFinishSession()`.
- **Instant UI & DB State Sync**: Instantly updates Supabase `sessions` (`status: "finished"`, `finished_at: timestamp`) and local state simultaneously, transitioning directly to the Finished session summary view without hanging.
- **Removed Outdated Alerts**: Removed the legacy sequence-end toast notification that previously halted sequence completion.

#### Fisher-Yates Shuffle Feature (`sessions/[id].tsx`)
- **Unbiased Randomization**: Implemented `fisherYatesShuffle()` algorithm to randomize the word sequence prior to starting lessons.
- **Shuffle Buttons in Pending View**:
  - Full-width "Shuffle Words" secondary button with shuffle icon positioned right above the "Launch Session" button.
  - Compact "Shuffle" quick-action chip located in the Timed Sequence section header.
- **Instant UI Reordering & DB Persistence**: Instantly updates local state (`setSessionWords` and `sessionWordsRef`) for immediate visual feedback, while launching background Supabase batch updates to persist the new `order_index` across app reloads.
- **Disabled During Playback**: Guarded against execution and hidden from UI whenever the session status is `'in_progress'` or `'paused'`.

#### Word Bank Difficulty Filtering & Auto-Detection (`lib/difficulty.ts`, `wordbank/index.tsx`, `sessions/add-word.tsx`)
- **Difficulty Filter Chips**: Added "Easy", "Medium", and "Hard" filter chips to both the main Word Bank screen and the session word picker flow.
- **Automatic Difficulty Detection**: Dynamically categorizes new words by letter length as the teacher types (Easy: 1–3 letters, Medium: 4–6 letters, Hard: 7+ letters).
- **Manual Difficulty Override**: Allows teachers to tap any difficulty chip to override the auto-suggested tier before saving.
- **Centralized Difficulty Metadata**: Created `lib/difficulty.ts` with typed definitions, color mappings (`blueWash`, `amber`, `redBg`), and length calculators.

#### Strict A-Z Character Validation (`wordbank/index.tsx`, `sessions/add-word.tsx`, `sessions/[id].tsx`)
- Applied `.replace(/[^a-zA-Z]/g, '').toUpperCase()` regex sanitization across all word text inputs (Word Bank "New Word", session "Add Word", and Live Session manual input) to strictly restrict input to letters A–Z.

### Changed

#### Session Type Renaming
- **"Manual" → "Live Session"**: Renamed across UI cards, modals, headers, badges, and database queries.
- **"Word List" → "Timed Sequence"**: Renamed across all session builders, lists, headers, and documentation.
- **Centralized Session Type Logic** (`lib/session-timer.ts`): Created helper functions (`isTimedSequence`, `isLiveSession`, `getSessionTypeLabel`) with transparent backward compatibility for existing records in Supabase.

#### Educational UI Polish for Cooldown Phase (`sessions/[id].tsx`)
- Replaced technical engineering jargon with intuitive classroom-oriented terms:
  - *"Cooldown phase..."* → **"Student Break"**
  - *"Resting solenoids before next word: "* → **"Get ready for the next word: "**
  - *"Solenoids de-energized"* → **"Display Cleared"**
  - Updated Device Display hint to *"Display is cleared for a short break before the next word."*

### Fixed

#### Missing Style Crash in Word Bank (`wordbank/index.tsx`)
- Defined missing `chipActiveLabel` style object in `StyleSheet`, ensuring high-contrast white bold text against active difficulty chips.

---

## [2026-09-24] — Stability, Routing & Realtime Audit

### Added
- **Global Error Boundary** (`components/ErrorBoundary.tsx`) — React class component
  that catches any uncaught render error anywhere in the app and displays a styled
  recovery card ("Try Again" / "Go to Dashboard") instead of a black or white screen.
  Wired into the root `app/_layout.tsx` as a single top-level wrapper. In dev builds,
  the raw error message is shown in a red debug box.

### Fixed

#### Realtime — Supabase channel cache collision (`Date.now()` suffix)
`supabase.channel("name")` returns the **cached existing channel** if one with that
name is still alive in Supabase's internal registry (async `removeChannel` may still
be in-flight on fast remounts). Calling `.on()` on that already-subscribed object
throws `"cannot add postgres_changes callbacks after subscribe()"`.

Fixed by appending `-${Date.now()}` to every channel name so each mount creates a
guaranteed-fresh channel object, making any in-flight cleanup from the previous mount
completely irrelevant.

| File | Was (static) | Now (unique per mount) |
|---|---|---|
| `sessions/[id].tsx` | `session-detail-${id}` | `session-detail-${id}-${Date.now()}` ✅ |
| `students/[id].tsx` | `student-detail-${id}` | `student-detail-${id}-${Date.now()}` ✅ |
| `students/index.tsx` | `students-realtime` | `students-realtime-${Date.now()}` ✅ |
| `dashboard.tsx` | `dashboard-realtime` | `dashboard-realtime-${Date.now()}` ✅ |
| `analytics.tsx` | `analytics-realtime` | `analytics-realtime-${Date.now()}` ✅ |
| `admin/index.tsx` | `admin-profiles-realtime` | `admin-profiles-realtime-${Date.now()}` ✅ |

#### `Alert.alert` → in-app Toast (`sessions/[id].tsx`)
Native `Alert.alert` blocks the UI thread on iOS and is visually inconsistent with the
app's custom `Toast` component. Three remaining alert calls replaced:

- Launch validation: "No students assigned" → slide-up Toast
- Launch validation: "No words in list" → slide-up Toast
- Send-word validation: "Invalid word" → slide-up Toast

Added `validationToast` state + `showValidationToast()` helper, rendered in both the
pending view (launch checks) and in-progress view (send-word check).

#### `Alert.alert` → inline error inside modal (`students/[id].tsx`)
Edit-name save error was using `Alert.alert("Error", ...)`. Replaced with an inline
`editError` state displayed directly in the bottom sheet, consistent with the existing
`pairError` pattern used in the pair-device sheet.

#### Silent delete failure → error toast (`students/[id].tsx`)
`deleteStudent()` silently swallowed DB errors with no user feedback.
Now shows a red toast: "Delete failed — Could not remove this student."

#### Infinite spinner bug (`students/[id].tsx`)
`loadData()` had an early-return guard `if (!id) return` that did **not** call
`setLoading(false)` before returning. If `id` was undefined, the spinner displayed
indefinitely with no recovery. Fixed by calling `setLoading(false)` before the return.

#### Analytics realtime dependency churn (`analytics.tsx`)
The realtime `useEffect` used `[loadAnalytics]` as its dependency. Since `loadAnalytics`
is recreated by `useCallback` every time `period` changes, switching the time filter
was destroying and recreating a Supabase channel on every tap — unnecessary WebSocket
churn. Fixed with a stable `loadAnalyticsRef` that updates without re-running the
effect (same pattern as `sessions/index.tsx`).

---

## [2026-09-23] — Navigation Audit & Realtime Subscription Lifecycle

### Fixed

#### `useFocusEffect` imported from wrong package (`students/index.tsx`)
Was imported from `@react-navigation/native` instead of `expo-router`. Using the raw
React Navigation version bypasses Expo Router's URL state, causing internal state
divergence that manifests as black screens on subsequent `router.push()` calls.

#### Race condition on mount — duplicate data fetch (`sessions/[id].tsx`)
A redundant `useEffect(() => { loadData() }, [loadData])` ran concurrently with
`useFocusEffect` on mount. Two async DB fetches raced to update state, with the slower
one silently discarding the faster one's result. Removed the redundant `useEffect`
since `useFocusEffect` already handles both initial mount and re-focus.

#### Tab press always navigates to stack root (`(teacher)/_layout.tsx`)
Added `tabPress` event listeners to Students, Sessions, and Word Bank tabs.
Without these, pressing a tab could land on a deep detail screen (e.g., `sessions/[id]`
or `wordbank/new`) instead of the list root, hiding the "Add Session" button.
All listeners use `router.navigate` (Expo Router, not raw `navigation.navigate`) to
keep Expo Router's URL state in sync.

#### Supabase realtime crash — `postgres_changes` after `subscribe()` (`sessions/[id].tsx`)
Root cause: `supabase.channel("session-detail-${id}")` returned the cached channel when
`removeChannel()` was still in-flight on fast remounts, causing `.on()` to throw on an
already-subscribed channel. Fixed with the `Date.now()` suffix approach. The
`realtimeChannelRef` guard was removed as it could not protect against Supabase's cache.

---

## [2026-09-22] — Word Bank & Session UX Improvements

### Added
- Duplicate check on "Save to Word Bank" — if a word already exists, it is automatically
  added to the current session word list instead, with a toast: *"The word already
  exists in the word bank and was added to your word list instead."*
- Remove button on word list items with delete confirmation and success toast.
- Toast notifications for all word bank CRUD actions.
- Real-time word bank sync — word bank opened during a session reflects new entries
  added via the main Word Bank tab.

### Fixed
- Top navigation bar ("New Word" / "Word Bank" / "Word List") centered correctly.
- Black screen on back navigation from word bank during a session.
- Sessions tab now always opens the session list, not a specific active session.
- Word Bank → Sessions → session tap black screen (Expo Router / React Navigation
  state divergence eliminated).

---

> **Convention:** Add new entries to `[Unreleased]` during development. Move to a
> dated section on each significant milestone or release.

### Added / Changed
* **Timed Sequence Auto-Cycle Engine:** Automated sequence playback with active countdowns and progress bars. Eliminated manual skips for strictly automated pacing.
* **Hardware Solenoid Safety Limits:** Strictly enforced 5s – 60s hard duration clamps (`MIN_WORD_DURATION_SEC`, `MAX_WORD_DURATION_SEC`) to prevent physical coil burnout. Added per-word stepper controls.
* **10-Second Hardware Cooldown (Student Break):** Automatic `clearDevices()` de-energizing solenoids immediately when a word's active timer hits 0. Added a 10s breather phase with "Display Cleared" status.
* **Auto-Finish on Final Word:** Zero-cooldown transition on the final word directly into `executeFinishSession()`. 
* **Fisher-Yates Shuffle Feature:** Unbiased random sequence permutation with instant UI updates and background Supabase `order_index` persistence in the Pending view.
* **Word Bank Difficulty Filtering & Auto-Detection:** Easy, Medium, and Hard filter chips across Word Bank and session selection. Length-based automatic difficulty suggestion with manual overrides.
* **Strict A-Z Input Validation:** Sanitized text inputs with `.replace(/[^a-zA-Z]/g, '')` across all word entry forms.
* **Session Type Rebranding & UI Polish:** "Manual" is now "Live Session" & "Word List" is now "Timed Sequence". Replaced engineering terminology with classroom-friendly language.

### Fixed
* **Session Concurrency Loophole:** Added a pre-flight database check to prevent launching or resuming multiple active sessions simultaneously.
* **Supabase Connection Drops:** Implemented `expo-keep-awake` to prevent screen dimming and WebSocket disconnects during active classes.
* **Missing Styles:** Added missing `chipActiveLabel` style in `wordbank/index.tsx` for contrast against active difficulty chips.