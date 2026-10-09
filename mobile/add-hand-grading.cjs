// add-hand-grading.cjs
// #4 Teacher fallback grading: during a live or timed session, the teacher
// can tap ✓ / ✗ for each student on the current word.
//   - No voice answer yet (mic broken, Wi-Fi down, child didn't press) → adds a grade
//   - Voice answer exists (e.g. "Review") → overrides it
//   - Works offline: grades are queued and synced later (outbox)
// Also: the live feed now loads earlier answers after an app reload.
//
// Run from the MOBILE folder:   node add-hand-grading.cjs
// (Replace lib/outbox.ts with the new one FIRST.)
// Backup saved as [id].tsx.bak6  (do NOT commit it)

const fs = require("fs");
const path = require("path");
const FILE = path.join(__dirname, "app", "(teacher)", "sessions", "[id].tsx");

if (!fs.existsSync(FILE)) {
  console.error("Could not find " + FILE + "\nRun this from the mobile folder.");
  process.exit(1);
}
const outbox = fs.readFileSync(path.join(__dirname, "lib", "outbox.ts"), "utf8");
if (!outbox.includes("insertOrQueue")) {
  console.error("Replace mobile/lib/outbox.ts with the new version first.");
  process.exit(1);
}

const raw = fs.readFileSync(FILE, "utf8");
const usesCRLF = raw.includes("\r\n");
let s = raw.replace(/\r\n/g, "\n");
const problems = [];

if (s.includes("HandGradeCard")) {
  console.log("Already applied — nothing to do.");
  process.exit(0);
}

function once(label, from, to) {
  if (s.split(from).length !== 2) return problems.push(label);
  s = s.replace(from, to);
}

// 1. Imports
once(
  "outbox import",
  'import { updateOrQueue } from "../../../lib/outbox";',
  'import { updateOrQueue, insertOrQueue, newId } from "../../../lib/outbox";'
);

// 2. Attempts know which student they belong to
once(
  "WordAttempt type",
  "type WordAttempt = {\n  id: string;\n",
  "type WordAttempt = {\n  id: string;\n  student_id?: string | null;\n"
);

// 3. The hand-grading card
once(
  "HandGradeCard component",
  "// ── Keep awake for active session",
  `// ── Teacher fallback grading (✓ / ✗ per student, current word) ─────────────

function HandGradeCard({
  word,
  students,
  attempts,
  onGrade,
}: {
  word: string;
  students: Student[];
  attempts: WordAttempt[];
  onGrade: (student: Student, word: string, correct: boolean, existing: WordAttempt | null) => void;
}) {
  if (!word || students.length === 0) return null;
  const w = word.toUpperCase();
  return (
    <View style={styles.sectionCard}>
      <Text style={styles.cardLabel}>GRADE BY HAND · {w}</Text>
      <Text style={hg.hint}>
        Tap ✓ or ✗ if the voice answer is missing or needs a check.
      </Text>
      <View style={{ gap: 8 }}>
        {students.map((st) => {
          // attempts are newest first → this is the student's latest answer
          const a = attempts.find((x) => x.student_id === st.id && x.word?.toUpperCase() === w) ?? null;
          const status = a ? attemptStatus(a) : null;
          const byTeacher = a?.graded_by === "teacher";
          return (
            <View key={st.id} style={hg.row}>
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={hg.name} numberOfLines={1}>{st.full_name}</Text>
                <Text
                  style={[hg.sub, status && { color: STATUS_STYLE[status].fg }]}
                  numberOfLines={1}
                >
                  {!a
                    ? "No answer yet"
                    : STATUS_STYLE[status!].short +
                      (byTeacher
                        ? " · graded by you"
                        : a.transcript
                        ? \` · heard "\${cleanTranscript(a.transcript)}"\`
                        : "")}
                </Text>
              </View>
              {a?.audio_path ? <PlayRecordingButton path={a.audio_path} /> : null}
              <Pressable
                onPress={() => onGrade(st, w, true, a)}
                hitSlop={6}
                style={({ pressed }) => [
                  hg.btn,
                  status === "correct" && { backgroundColor: C.green, borderColor: C.green },
                  pressed && { opacity: 0.7 },
                ]}
                accessibilityLabel={\`Mark \${st.full_name} correct\`}
              >
                <Ionicons name="checkmark" size={18} color={status === "correct" ? C.white : C.green} />
              </Pressable>
              <Pressable
                onPress={() => onGrade(st, w, false, a)}
                hitSlop={6}
                style={({ pressed }) => [
                  hg.btn,
                  status === "wrong" && { backgroundColor: C.red, borderColor: C.red },
                  pressed && { opacity: 0.7 },
                ]}
                accessibilityLabel={\`Mark \${st.full_name} wrong\`}
              >
                <Ionicons name="close" size={18} color={status === "wrong" ? C.white : C.red} />
              </Pressable>
            </View>
          );
        })}
      </View>
    </View>
  );
}

const hg = StyleSheet.create({
  hint: { fontFamily: fonts.body, fontSize: 12, color: C.muted, lineHeight: 17 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: C.bg,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  name: { fontFamily: fonts.bodyBold, fontSize: 14, color: C.ink },
  sub: { fontFamily: fonts.mono, fontSize: 10, color: C.muted },
  btn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    borderWidth: 1.5,
    borderColor: C.border,
    backgroundColor: C.white,
    alignItems: "center",
    justifyContent: "center",
  },
});

// ── Keep awake for active session`
);

// 4. Realtime: don't show the same answer twice (hand grades are added instantly)
once(
  "realtime dedupe",
  "          setLiveAttempts((prev) => [attempt, ...prev]);\n",
  "          setLiveAttempts((prev) =>\n" +
  "            prev.some((a) => a.id === attempt.id) ? prev : [attempt, ...prev]\n" +
  "          );\n"
);

// 5. Load earlier answers + the grading function
once(
  "gradeByHand",
  "  // ── Student assignment ──",
  `  // ── Earlier answers (so the feed survives an app reload) ───────────────────
  useEffect(() => {
    if (!id) return;
    supabase
      .from("word_attempts")
      .select("id, student_id, word, is_correct, response_time_ms, attempted_at, transcript, needs_review, audio_path, graded_by")
      .eq("session_id", id)
      .order("attempted_at", { ascending: false })
      .limit(200)
      .then(({ data }) => {
        if (!data) return;
        setLiveAttempts((prev) => {
          const seen = new Set(prev.map((a) => a.id));
          return [...prev, ...(data as WordAttempt[]).filter((a) => !seen.has(a.id))];
        });
      });
  }, [id]);

  // ── Teacher fallback grading ────────────────────────────────────────────────
  async function gradeByHand(
    student: Student,
    word: string,
    correct: boolean,
    existing: WordAttempt | null
  ) {
    const patch = { is_correct: correct, needs_review: false, graded_by: "teacher" };

    if (existing) {
      // Override the voice grade (or change your own earlier tap)
      setLiveAttempts((prev) => prev.map((a) => (a.id === existing.id ? { ...a, ...patch } : a)));
      const { error } = await updateOrQueue("word_attempts", patch, { id: existing.id });
      if (error) {
        setLiveAttempts((prev) => prev.map((a) => (a.id === existing.id ? existing : a)));
        showValidationToast("Couldn't save grade", error);
      }
      return;
    }

    // No answer yet → add one (id made here so an offline retry can't duplicate it)
    const row = {
      id: newId(),
      student_id: student.id,
      session_id: id!,
      word,
      response_time_ms: null,
      attempted_at: new Date().toISOString(),
      ...patch,
    };
    setLiveAttempts((prev) => [row, ...prev]);
    const { error } = await insertOrQueue("word_attempts", row);
    if (error) {
      setLiveAttempts((prev) => prev.filter((a) => a.id !== row.id));
      showValidationToast("Couldn't save grade", error);
    }
  }

  // ── Student assignment ──`
);

// 6. Live session: card above "Words sent"
once(
  "live card",
  "            {/* Words sent history + live student responses */}",
  `            {/* Teacher fallback: grade the current word by hand */}
            <HandGradeCard
              word={lastSentWord}
              students={assignedStudents}
              attempts={liveAttempts}
              onGrade={gradeByHand}
            />

            {/* Words sent history + live student responses */}`
);

// 7. Timed sequence: card above its live feed
once(
  "timed card",
  "        {/* ── Timed Sequence: live responses feed",
  `        {/* ── Timed Sequence: grade the current word by hand ─────────── */}
        {isTimedSequence(session.type) && (
          <HandGradeCard
            word={sessionWords[wordListIndex]?.word ?? ""}
            students={assignedStudents}
            attempts={liveAttempts}
            onGrade={gradeByHand}
          />
        )}

        {/* ── Timed Sequence: live responses feed`
);

if (problems.length) {
  console.error("Nothing was changed. Could not find these parts:\n - " + problems.join("\n - "));
  console.error("Push your code and tell me — I'll check.");
  process.exit(1);
}

fs.writeFileSync(FILE + ".bak6", raw);
fs.writeFileSync(FILE, usesCRLF ? s.replace(/\n/g, "\r\n") : s);
console.log("Done! Teachers can now grade by hand during a session.");
console.log("Backup saved as [id].tsx.bak6 (delete it before committing)");
