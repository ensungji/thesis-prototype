// mobile/lib/pdf-report.ts
// The printable layout of the three reports (per student, per session,
// analytics period) as HTML, turned into a PDF with expo-print and handed to
// the share sheet. The data comes from lib/report-data.ts.
//
// Layout: A4 landscape; title, date range, generated-at time and teacher on
// top; page numbers in the page margin (CSS @page margin boxes, Android
// WebView 131+); table headers repeat on every page; a page break between
// students / sessions; the data dictionary on the last page.
//
// expo-print is a native module: on a build made before it was added, export
// stops with a clear message instead of crashing.

import { requireOptionalNativeModule } from "expo";
import { shareCsv, toCsv } from "./csv-share";
import { agreementSentence } from "./review";
import {
  type Group,
  type Metrics,
  type Report,
  type ReportAnswer,
  type ReportSession,
  type StudentSummary,
  GROUPS,
  LENGTH_KEYS,
  LENGTH_LABEL,
  TYPE_KEYS,
  TYPE_LABEL,
  ReportError,
  csvColumns,
  fmtDate,
  fmtDateTime,
  fmtDuration,
  fmtTime,
  lengthKeyOf,
  ms,
  num,
  pct,
  reportCsvRows,
  yesNo,
} from "./report-data";

// ── HTML helpers ──────────────────────────────────────────────────────────────

const esc = (v: unknown) =>
  String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const cssString = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\r\n]+/g, " ")}"`;

const td = (v: unknown, cls = "") => `<td${cls ? ` class="${cls}"` : ""}>${esc(v)}</td>`;
const th = (v: unknown, cls = "") => `<th${cls ? ` class="${cls}"` : ""}>${esc(v)}</th>`;

function table(head: string[], rows: string[], cls = "") {
  return (
    `<table class="${cls}"><thead><tr>${head.map((h) => th(h)).join("")}</tr></thead>` +
    `<tbody>${rows.join("") || `<tr><td colspan="${head.length}" class="empty">Nothing in this period.</td></tr>`}</tbody></table>`
  );
}

const kv = (rows: [string, unknown][]) =>
  `<table class="kv"><tbody>${rows.map(([k, v]) => `<tr><th>${esc(k)}</th>${td(v || "—")}</tr>`).join("")}</tbody></table>`;

const blank = (v: string | number | null | undefined) => (v == null || v === "" ? "—" : v);

// ── Metric rows (shared by every summary and the group comparison) ───────────

type MetricDef = { label: string; get: (m: Metrics) => string; def: string };

const agreementValue = (m: Metrics) =>
  m.agreement.voice
    ? `${m.agreement.agreed}/${m.agreement.voice} (${pct(m.agreementPct)})` +
      (m.agreement.stillReview ? ` · ${m.agreement.stillReview} still review` : "")
    : m.agreement.stillReview
      ? `— · ${m.agreement.stillReview} still review`
      : "—";

export const METRICS: MetricDef[] = [
  { label: "Answers", get: (m) => String(m.answers), def: "Every final answer row in the report: one per student per word shown (word_attempts)." },
  { label: "Scored answers", get: (m) => String(m.scored), def: "Answers minus those still marked Review (needs_review). Accuracy is calculated over these." },
  { label: "Correct", get: (m) => String(m.correct), def: "Scored answers whose final result is correct." },
  { label: "Accuracy", get: (m) => pct(m.accuracy), def: "Correct ÷ scored answers. No answer and skipped count as wrong, answers still waiting for review are left out (the same rule as the Analytics tab)." },
  { label: "First-try correct", get: (m) => String(m.firstTryCorrect), def: "Correct answers whose first correct voice try was try 1 (or, with no voice try saved, a correct answer with at most 1 try)." },
  { label: "First-try accuracy", get: (m) => pct(m.firstTryAccuracy), def: "First-try correct ÷ scored answers." },
  { label: "Average tries per word", get: (m) => num(m.avgTries), def: "Mean of tries over every answer except skipped ones (no answer = 0 tries; a teacher grade without a voice try = 0)." },
  { label: "Average tries until correct", get: (m) => num(m.avgTriesUntilCorrect), def: "Over correct answers only: the try number of the first try graded correct by voice. If no try was correct by voice (the teacher marked it correct, or tries from before every try was kept), the number of tries, at least 1." },
  { label: "Average response time", get: (m) => ms(m.avgResponseMs), def: "Mean response time of the final answers that have one (response_time_ms above 0)." },
  { label: "Fastest response", get: (m) => ms(m.fastestMs), def: "Shortest of those response times." },
  { label: "Slowest response", get: (m) => ms(m.slowestMs), def: "Longest of those response times." },
  { label: "Answers with a response time", get: (m) => String(m.timed), def: "How many answers the three response figures are based on." },
  { label: "No answer", get: (m) => String(m.noAnswer), def: "Answers saved as No answer: the word ended before the student answered (graded_by 'missed')." },
  { label: "No-answer rate", get: (m) => pct(m.noAnswerRate), def: "No answer ÷ all answers." },
  { label: "Skipped", get: (m) => String(m.skipped), def: "Activity sessions: the teacher moved on (Next / End) before the student answered (graded_by 'skipped')." },
  { label: "Needs review", get: (m) => String(m.needsReview), def: "Answers still marked Review (needs_review): not scored until the teacher decides." },
  { label: "Re-graded answers", get: (m) => String(m.regraded), def: "Answers changed by the teacher after the session ended (regraded_at set)." },
  { label: "Speech grading agreement", get: agreementValue, def: "Voice answers the teacher agreed with ÷ voice answers (lib/review.ts, the same rule as the Review screen and the admin panel). A voice answer = still graded by voice, or re-graded from a voice grade. It disagrees if the teacher re-graded it to a different correct / wrong. Answers still marked Review aren't counted (shown as 'still review'). Only sessions marked Done reviewing count; the session report counts its own answers even before Done reviewing." },
];

const lengthRows = (get: (m: Metrics) => Metrics["byLength"]) =>
  LENGTH_KEYS.map((k) => ({
    label: `${LENGTH_LABEL[k]}: accuracy / avg response`,
    get: (m: Metrics) => {
      const s = get(m)[k];
      return s.scored ? `${pct(s.accuracy)} (${s.correct}/${s.scored}) · ${ms(s.avgResponseMs)}` : "—";
    },
  }));

const typeRows = TYPE_KEYS.map((k) => ({
  label: `${TYPE_LABEL[k]} sessions: accuracy`,
  get: (m: Metrics) => {
    const s = m.byType[k];
    return s.scored ? `${pct(s.accuracy)} (${s.correct}/${s.scored})` : "—";
  },
}));

function metricsTable(m: Metrics) {
  return table(
    ["Metric", "Value"],
    METRICS.map((d) => `<tr>${td(d.label)}${td(d.get(m))}</tr>`),
    "metrics",
  );
}

function lengthTable(m: Metrics) {
  return table(
    ["Word length", "Scored", "Correct", "Accuracy", "Avg response"],
    LENGTH_KEYS.filter((k) => k !== "other" || m.byLength.other.scored > 0).map((k) => {
      const s = m.byLength[k];
      return `<tr>${td(LENGTH_LABEL[k])}${td(s.scored)}${td(s.correct)}${td(pct(s.accuracy))}${td(ms(s.avgResponseMs))}</tr>`;
    }),
    "narrow",
  );
}

function typeTable(m: Metrics) {
  return table(
    ["Session type", "Scored", "Correct", "Accuracy", "Avg response"],
    TYPE_KEYS.filter((k) => k !== "unknown" || m.byType.unknown.scored > 0).map((k) => {
      const s = m.byType[k];
      return `<tr>${td(TYPE_LABEL[k])}${td(s.scored)}${td(s.correct)}${td(pct(s.accuracy))}${td(ms(s.avgResponseMs))}</tr>`;
    }),
    "narrow",
  );
}

function groupTable(groups: Record<Group, Metrics>, all: Metrics) {
  const cols: [string, Metrics][] = [...GROUPS.map((g) => [g, groups[g]] as [string, Metrics]), ["All", all]];
  const rows = [...METRICS, ...lengthRows((m) => m.byLength), ...typeRows].map(
    (d) => `<tr>${td(d.label)}${cols.map(([, m]) => td(d.get(m))).join("")}</tr>`,
  );
  return table(["Metric", ...cols.map(([g]) => g)], rows, "groups");
}

function studentsTable(list: StudentSummary[], rankLabel: string) {
  return table(
    [rankLabel, "Student", "Group", "Device", "Answers", "Scored", "Correct", "Accuracy", "1st-try acc.", "Avg tries", "Tries → correct",
      "Avg resp.", "Fastest", "Slowest", "No answer", "No-ans. rate", "Skipped", "Review", "Re-graded", "Agreement"],
    list.map((s) => {
      const m = s.metrics;
      return (
        `<tr>${td(blank(s.rank))}${td(s.name)}${td(s.group)}${td(blank(s.deviceCode))}${td(m.answers)}${td(m.scored)}${td(m.correct)}` +
        `${td(pct(m.accuracy))}${td(pct(m.firstTryAccuracy))}${td(num(m.avgTries))}${td(num(m.avgTriesUntilCorrect))}` +
        `${td(ms(m.avgResponseMs))}${td(ms(m.fastestMs))}${td(ms(m.slowestMs))}${td(m.noAnswer)}${td(pct(m.noAnswerRate))}` +
        `${td(m.skipped)}${td(m.needsReview)}${td(m.regraded)}${td(agreementValue(m))}</tr>`
      );
    }),
    "wide",
  );
}

function studentsByLengthTable(list: StudentSummary[]) {
  const cell = (s: { scored: number; correct: number; accuracy: number | null; avgResponseMs: number | null }) =>
    s.scored ? `${pct(s.accuracy)} (${s.correct}/${s.scored}) · ${ms(s.avgResponseMs)}` : "—";
  return table(
    ["Student", "Group", ...LENGTH_KEYS.map((k) => LENGTH_LABEL[k]), ...TYPE_KEYS.map((k) => TYPE_LABEL[k])],
    list.map(
      (s) =>
        `<tr>${td(s.name)}${td(s.group)}${LENGTH_KEYS.map((k) => td(cell(s.metrics.byLength[k]))).join("")}` +
        `${TYPE_KEYS.map((k) => td(cell(s.metrics.byType[k]))).join("")}</tr>`,
    ),
    "wide",
  );
}

// ── Answer tables (every answer, every try under it) ─────────────────────────

const ANSWER_HEAD = ["#", "Word", "Len", "Hold", "Answered / try time", "Device", "Heard", "Conf.", "Result", "Needs review",
  "Tries", "Resp. ms", "Resp. s", "Graded by", "Original (before re-grade)", "Re-graded by / at", "Late", "Rec. saved"];

const s2 = (x: number | null) => (x == null ? "—" : (x / 1000).toFixed(2));
const conf = (x: number | null) => (x == null ? "—" : x.toFixed(2));

function answerRows(a: ReportAnswer): string {
  const resultCls = `r-${a.result.replace(" ", "-")}`;
  const original = a.regradedAt ? `${a.originalResult} by ${a.originalGrader}` : "—";
  const regraded = a.regradedAt ? `${a.regradedBy} · ${fmtDateTime(a.regradedAt)}` : "—";
  const main =
    `<tr class="answer">${td(blank(a.position))}${td(a.word, "word")}${td(a.wordLength)}${td(a.holdSeconds == null ? "—" : `${a.holdSeconds} s`)}` +
    `${td(fmtDateTime(a.answeredAt))}${td(blank(a.deviceCode))}${td(blank(a.heard ? `“${a.heard}”` : ""))}${td(conf(a.confidence))}` +
    `${td(a.result, resultCls)}${td(a.needsReview ? "yes" : "no")}${td(a.tries)}${td(blank(a.responseMs))}${td(s2(a.responseMs))}` +
    `${td(blank(a.gradedBy))}${td(original)}${td(regraded)}${td(yesNo(a.late))}${td(a.recordingSaved ? "yes" : "no")}</tr>`;
  const old = a.heardOld
    ? `<tr class="try"><td></td><td colspan="${ANSWER_HEAD.length - 1}">Older heard-text column: “${esc(a.heardOld)}”</td></tr>`
    : "";
  const tries = a.tryList
    .map(
      (t) =>
        `<tr class="try">${td(`↳ try ${t.attemptNo}`)}${td("")}${td("")}${td("")}${td(fmtDateTime(t.at))}${td(blank(t.deviceCode))}` +
        `${td(blank(t.heard ? `“${t.heard}”` : ""))}${td(conf(t.confidence))}${td(t.result, `r-${t.result}`)}${td("")}${td(t.attemptNo)}` +
        `${td(blank(t.responseMs))}${td(s2(t.responseMs))}${td("voice")}${td("")}${td("")}${td(yesNo(t.late))}${td(t.recordingSaved ? "yes" : "no")}</tr>`,
    )
    .join("");
  return main + old + tries;
}

function answerTable(answers: ReportAnswer[], missingWords: ReportSession["words"] = []) {
  // Answers in their order (report-data sorts them); words with no answer row
  // slot in at their position
  const items = answers.map((a, i) => ({ pos: a.position ?? Number.MAX_SAFE_INTEGER, i, html: answerRows(a) }));
  for (const w of missingWords) {
    items.push({
      pos: w.position,
      i: -1,
      html: `<tr class="answer missing">${td(w.position)}${td(w.word, "word")}${td(w.word.length)}${td(w.holdSeconds == null ? "—" : `${w.holdSeconds} s`)}` +
        `<td colspan="${ANSWER_HEAD.length - 4}">No answer row saved (the word wasn't shown to this student, or the session ended first).</td></tr>`,
    });
  }
  items.sort((x, y) => x.pos - y.pos || x.i - y.i);
  return table(ANSWER_HEAD, items.map((x) => x.html), "answers");
}

function sessionLine(s: ReportSession | null): string {
  if (!s) return "Session deleted (its answers are kept; word position and hold time are no longer known)";
  const parts = [
    TYPE_LABEL[s.typeKey],
    s.startedAt ? `${fmtDate(s.startedAt)} ${fmtTime(s.startedAt)}–${s.finishedAt ? fmtTime(s.finishedAt) : "not finished"}` : "not started",
    s.activityName ? `activity “${s.activityName}”${s.activityAuthor ? ` by ${s.activityAuthor}` : ""}` : "",
    s.reviewedAt ? `reviewed ${fmtDateTime(s.reviewedAt)}` : "not reviewed",
  ].filter(Boolean);
  return parts.join(" · ");
}

/** One student's answers, one block per session. */
function answersBySession(answers: ReportAnswer[], breakBetween: boolean) {
  const bySession = new Map<string, ReportAnswer[]>();
  for (const a of answers) {
    const k = a.session?.id ?? "deleted";
    bySession.set(k, [...(bySession.get(k) ?? []), a]);
  }
  return [...bySession.values()]
    .map((list, i) => {
      const s = list[0].session;
      return (
        `<div class="block${breakBetween && i > 0 ? " break" : ""}">` +
        `<h3>${esc(s?.name ?? "Session deleted")}</h3><p class="meta">${esc(sessionLine(s))} · ${list.length} answer${list.length === 1 ? "" : "s"}</p>` +
        answerTable(list) +
        `</div>`
      );
    })
    .join("");
}

// ── Pages ─────────────────────────────────────────────────────────────────────

function cover(r: Report) {
  return (
    `<div class="cover"><div class="brand">Braille D.O.T.S.</div><h1>${esc(r.title)}</h1>` +
    `<table class="kv cover-kv"><tbody>` +
    `<tr><th>${r.kind === "session" ? "Session type" : "Period"}</th>${td(r.subtitle)}</tr>` +
    `<tr><th>Date range</th>${td(r.rangeText)}</tr>` +
    `<tr><th>Generated</th>${td(`${fmtDateTime(r.generatedAt)} (Asia/Manila)`)}</tr>` +
    `<tr><th>Teacher</th>${td(r.teacherName)}</tr>` +
    `</tbody></table></div>`
  );
}

function studentPages(r: Report) {
  const s = r.students[0];
  const m = s.metrics;
  return (
    `<h2>Student</h2>` +
    kv([
      ["Name / code", s.name],
      ["Group", s.group],
      ["Paired device", s.deviceCode || "none"],
      ["Class standing", s.rank != null
        ? `Rank ${s.rank} of ${r.rankedOf} students with answers in this period (by accuracy; ties by number of scored answers)`
        : `Not ranked: no scored answers in this period (${r.rankedOf} students ranked)`],
      ["Sessions with answers", String(r.sessions.length)],
    ]) +
    `<h2>Metrics</h2>${metricsTable(m)}` +
    `<div class="row"><div><h3>By word length</h3>${lengthTable(m)}</div><div><h3>By session type</h3>${typeTable(m)}</div></div>` +
    `<p class="meta">${esc(agreementSentence(m.agreement))}. Reviewed sessions only.</p>` +
    `<h2 class="break">Every answer and try, by session</h2>` +
    (r.answers.length ? answersBySession(r.answers, true) : `<p class="meta">No answers in this period.</p>`)
  );
}

function sessionPages(r: Report) {
  const s = r.sessions[0];
  const started = s.startedAt ? new Date(s.startedAt).getTime() : null;
  const finished = s.finishedAt ? new Date(s.finishedAt).getTime() : null;
  const reviewed = !!s.reviewedAt;
  const wordsHead = ["#", "Word", "Letters", "Length group", "Hold time", "Answers", "Correct"];
  const answersByStudent = (id: string) => r.answers.filter((a) => a.studentId === id);
  return (
    `<h2>Session details</h2>` +
    kv([
      ["Name", s.name],
      ["Type", TYPE_LABEL[s.typeKey]],
      ["Purpose", s.purpose],
      ["Status", s.status],
      ["Date", fmtDate(s.startedAt ?? s.createdAt)],
      ["Created", fmtDateTime(s.createdAt)],
      ["Start time", fmtDateTime(s.startedAt)],
      ["End time", fmtDateTime(s.finishedAt)],
      ["Duration", started && finished ? `${fmtDuration(finished - started)} (start to end, pauses included)` : ""],
      ["Activity", s.activityName ? `${s.activityName}${s.activityAuthor ? ` · by ${s.activityAuthor}` : ""}` : "not an activity session"],
      ["Reviewed at", reviewed ? fmtDateTime(s.reviewedAt) : "not marked Done reviewing"],
      ["Words / participants", `${s.words.length} words · ${s.studentIds.length} students`],
    ]) +
    `<h2>Word list (in order)</h2>` +
    table(
      wordsHead,
      s.words.map((w) => {
        const list = r.answers.filter((a) => a.position === w.position);
        return (
          `<tr>${td(w.position)}${td(w.word, "word")}${td(w.word.length)}${td(LENGTH_LABEL[lengthKeyOf(w.word.length)])}` +
          `${td(w.holdSeconds == null ? "—" : `${w.holdSeconds} s${s.typeKey === "activity" ? " (not used: teacher-paced)" : ""}`)}` +
          `${td(list.length)}${td(list.filter((a) => a.result === "correct").length)}</tr>`
        );
      }),
      "narrow",
    ) +
    `<h2 class="break">Participants: metrics for this session</h2>${studentsTable(r.students, "Rank in session")}` +
    `<h2>Group comparison</h2>${groupTable(r.groups, r.overall)}` +
    `<h2>Speech grading agreement</h2><p>${esc(agreementSentence(r.overall.agreement))}.` +
    `${r.overall.agreement.stillReview ? ` ${r.overall.agreement.stillReview} answer(s) still marked Review are not counted.` : ""}` +
    `${reviewed ? "" : " <b>Provisional:</b> this session isn't marked Done reviewing yet."}</p>` +
    r.students
      .map((st) => {
        const list = answersByStudent(st.id);
        const answered = new Set(list.map((a) => a.position));
        const missing = s.words.filter((w) => !answered.has(w.position));
        return (
          `<div class="block break"><h2>${esc(st.name)} <span class="tag">${esc(st.group)}</span></h2>` +
          `<p class="meta">Device now: ${esc(st.deviceCode || "none")} · ${list.length} answers · accuracy ${pct(st.metrics.accuracy)} · ` +
          `first try ${pct(st.metrics.firstTryAccuracy)} · avg response ${ms(st.metrics.avgResponseMs)}</p>` +
          answerTable(list, missing) +
          `</div>`
        );
      })
      .join("")
  );
}

function periodPages(r: Report) {
  const m = r.overall;
  const withAnswers = r.students.filter((s) => s.metrics.answers > 0);
  const scoredStudents = r.students.filter((s) => s.metrics.accuracy != null);
  const classAvg = scoredStudents.length
    ? scoredStudents.reduce((t, s) => t + (s.metrics.accuracy ?? 0), 0) / scoredStudents.length
    : null;
  const timedStudents = r.students.filter((s) => s.metrics.avgResponseMs != null);
  const classResp = timedStudents.length
    ? timedStudents.reduce((t, s) => t + (s.metrics.avgResponseMs ?? 0), 0) / timedStudents.length
    : null;
  const sessionRows = r.sessions.map((s) => {
    const list = r.answers.filter((a) => a.session?.id === s.id);
    const scored = list.filter((a) => !a.needsReview);
    const correct = scored.filter((a) => a.isCorrect).length;
    const dur = s.startedAt && s.finishedAt ? new Date(s.finishedAt).getTime() - new Date(s.startedAt).getTime() : null;
    return (
      `<tr>${td(fmtDate(s.startedAt ?? s.createdAt))}${td(s.name)}${td(TYPE_LABEL[s.typeKey])}${td(blank(s.purpose))}` +
      `${td(blank(s.activityName ? `${s.activityName}${s.activityAuthor ? ` · by ${s.activityAuthor}` : ""}` : ""))}` +
      `${td(blank(fmtTime(s.startedAt)))}${td(blank(fmtTime(s.finishedAt)))}${td(blank(fmtDuration(dur)))}${td(s.status)}` +
      `${td(s.words.length)}${td(s.studentIds.length)}${td(list.length)}${td(scored.length ? pct(correct / scored.length) : "—")}` +
      `${td(s.reviewedAt ? fmtDateTime(s.reviewedAt) : "no")}</tr>`
    );
  });
  const deletedCount = r.answers.filter((a) => !a.session).length;
  return (
    `<h2>Class overview</h2>` +
    kv([
      ["Students", `${r.students.length} (${withAnswers.length} with answers in this period)`],
      ["Sessions in the period", `${r.sessions.length}${deletedCount ? ` (+ ${deletedCount} answers from deleted sessions)` : ""}`],
      ["Answers", `${m.answers} (${m.scored} scored)`],
      ["Class accuracy (average of students, as in the Analytics tab)", pct(classAvg)],
      ["Pooled accuracy (all scored answers together)", pct(m.accuracy)],
      ["Average response (average of students, as in the Analytics tab)", ms(classResp)],
      ["Average response (all answers together)", ms(m.avgResponseMs)],
    ]) +
    `<h2>Metrics: whole class</h2>${metricsTable(m)}` +
    `<div class="row"><div><h3>By word length</h3>${lengthTable(m)}</div><div><h3>By session type</h3>${typeTable(m)}</div></div>` +
    `<h2 class="break">Group comparison</h2>${groupTable(r.groups, m)}` +
    `<h2 class="break">Every student's metrics</h2>${studentsTable(r.students, "Rank")}` +
    `<p class="meta">Rank = by accuracy, ties by number of scored answers; students with no scored answers aren't ranked.</p>` +
    `<h2>Every student by word length and session type</h2><p class="meta">Accuracy (correct/scored) · average response.</p>${studentsByLengthTable(r.students)}` +
    `<h2 class="break">Sessions in the period</h2>` +
    table(["Date", "Session", "Type", "Purpose", "Activity", "Start", "End", "Duration", "Status", "Words", "Students", "Answers", "Accuracy", "Reviewed"], sessionRows, "wide") +
    withAnswers
      .map((s) => {
        const list = r.answers.filter((a) => a.studentId === s.id);
        return (
          `<div class="block break"><h2>${esc(s.name)} <span class="tag">${esc(s.group)}</span></h2>` +
          `<p class="meta">${list.length} answers · accuracy ${pct(s.metrics.accuracy)} · rank ${blank(s.rank)} of ${r.rankedOf}</p>` +
          answersBySession(list, false) +
          `</div>`
        );
      })
      .join("")
  );
}

function dictionary(r: Report) {
  return (
    `<div class="break"><h2>Data dictionary</h2>` +
    `<p class="meta">Times are Asia/Manila (UTC+8). Students appear only by their stored name or code. Recordings are never ` +
    `included: “recording saved” only says whether one is stored. The CSV export has the same rows as the answer tables, one row ` +
    `per try (the answer and session columns repeat on each try; an answer with no voice try has one row with empty try columns).</p>` +
    `<h3>Columns (answer tables and CSV)</h3>` +
    table(["Column", "Meaning"], csvColumns(r).map((c) => `<tr>${td(c.key, "word")}${td(c.meaning)}</tr>`), "dict") +
    `<h3>Calculated metrics</h3>` +
    table(["Metric", "How it is calculated"], [
      ...METRICS.map((d) => `<tr>${td(d.label)}${td(d.def)}</tr>`),
      `<tr>${td("By word length")}${td("The same accuracy and average response, split into 3 letters, 5 letters, more than 5 letters (and other lengths when there are any).")}</tr>`,
      `<tr>${td("By session type")}${td("The same accuracy, split into Live, Timed and Activity sessions (Unknown = the session was deleted).")}</tr>`,
      `<tr>${td("Groups")}${td("Beginner = name/code starting with B and a digit (B01–B10), Intermediate = I and a digit (I01–I05), Other = any other name. Every metric is calculated the same way per group.")}</tr>`,
      `<tr>${td("Class standing / rank")}${td("Students of this teacher ranked by accuracy in the period (high first); ties broken by number of scored answers (more first); equal on both = same rank. Students with no scored answers aren't ranked.")}</tr>`,
      `<tr>${td("Answer vs try")}${td("An answer is the final result per student per word (word_attempts). A try is each voice answer the device sent for that word (answer_attempts); retries replace a wrong / review / no-answer result until it is correct by voice.")}</tr>`,
    ], "dict") +
    `</div>`
  );
}

const CSS = (r: Report) => `
@page {
  size: A4 landscape;
  margin: 11mm 9mm 13mm 9mm;
  @bottom-left { content: ${cssString(`Braille D.O.T.S. · ${r.title} · generated ${fmtDateTime(r.generatedAt)}`)}; font: 7pt Arial, sans-serif; color: #666; }
  @bottom-right { content: "Page " counter(page) " of " counter(pages); font: 7pt Arial, sans-serif; color: #666; }
}
* { box-sizing: border-box; }
body { font-family: Arial, Helvetica, sans-serif; font-size: 8pt; color: #1a1e2a; margin: 0; }
h1 { font-size: 18pt; color: #0c447c; margin: 4px 0 10px; }
h2 { font-size: 12pt; color: #0c447c; margin: 14px 0 6px; border-bottom: 1.5px solid #0c447c; padding-bottom: 2px; }
h3 { font-size: 9.5pt; color: #5c3800; margin: 10px 0 4px; }
h2, h3 { break-after: avoid; page-break-after: avoid; }
p { margin: 4px 0; }
.meta { color: #555; font-size: 7.5pt; }
.brand { font-size: 9pt; letter-spacing: 1px; color: #5c3800; text-transform: uppercase; }
.cover { border: 1.5px solid #0c447c; border-radius: 6px; padding: 10px 14px; margin-bottom: 8px; }
.tag { font-size: 8pt; background: #e6f1fb; color: #0c447c; padding: 1px 6px; border-radius: 8px; font-weight: normal; }
.break { break-before: page; page-break-before: always; }
.block { margin-top: 6px; }
.row { display: flex; gap: 14px; break-inside: avoid; page-break-inside: avoid; }
.row > div { flex: 1; }
table { width: 100%; border-collapse: collapse; margin: 2px 0 6px; }
thead { display: table-header-group; }
tr { break-inside: avoid; page-break-inside: avoid; }
th, td { border: 0.5px solid #c9c9c4; padding: 2px 3px; text-align: left; vertical-align: top; }
th { background: #e6f1fb; color: #0c447c; font-weight: bold; }
table.kv { width: auto; min-width: 55%; }
table.kv th { width: 210px; }
table.cover-kv { border: none; }
table.cover-kv th, table.cover-kv td { border: none; background: none; padding: 1px 8px 1px 0; font-size: 9pt; }
table.narrow { width: auto; }
table.metrics { width: auto; min-width: 50%; }
table.answers { font-size: 7pt; }
table.wide { font-size: 7pt; }
table.dict td:first-child { white-space: nowrap; }
tr.try td { background: #fafaf7; color: #444; font-size: 6.5pt; }
tr.missing td { color: #8a8a86; font-style: italic; }
td.word { font-family: "Courier New", monospace; font-weight: bold; letter-spacing: 1px; }
td.empty { color: #8a8a86; text-align: center; }
.r-correct { color: #3b6d11; font-weight: bold; }
.r-wrong { color: #a32d2d; font-weight: bold; }
.r-review { color: #5c3800; font-weight: bold; }
.r-no-answer, .r-skipped { color: #8a8a86; font-weight: bold; }
`;

export function reportHtml(r: Report): string {
  const body = r.kind === "student" ? studentPages(r) : r.kind === "session" ? sessionPages(r) : periodPages(r);
  return (
    `<!doctype html><html><head><meta charset="utf-8"><title>${esc(r.title)}</title><style>${CSS(r)}</style></head>` +
    `<body>${cover(r)}${body}${dictionary(r)}</body></html>`
  );
}

// ── Export ────────────────────────────────────────────────────────────────────

/** Make the PDF and open the share sheet. Resolves when the sheet closes. */
export async function shareReportPdf(r: Report): Promise<void> {
  if (!requireOptionalNativeModule("ExpoPrint")) {
    throw new ReportError("This app build can't make PDFs yet. Install the latest app build (it adds PDF export).");
  }
  if (!requireOptionalNativeModule("ExpoSharing") || !requireOptionalNativeModule("FileSystem")) {
    throw new ReportError("This app build can't share files. Install the latest app build.");
  }
  const [Print, Sharing, { File, Paths }] = await Promise.all([
    import("expo-print"),
    import("expo-sharing"),
    import("expo-file-system"),
  ]);
  // A4 landscape (842 × 595 pt); margins come from @page in the CSS
  const { uri } = await Print.printToFileAsync({ html: reportHtml(r), width: 842, height: 595 });

  // Give it a readable file name (falls back to the generated one)
  let shareUri = uri;
  try {
    const target = new File(Paths.cache, `${r.fileBase}.pdf`);
    if (target.exists) target.delete();
    new File(uri).move(target);
    shareUri = target.uri;
  } catch {
    // keep the original name
  }
  if (!(await Sharing.isAvailableAsync())) throw new ReportError("Sharing isn't available on this phone.");
  await Sharing.shareAsync(shareUri, { mimeType: "application/pdf", UTI: "com.adobe.pdf", dialogTitle: r.title });
}

/** The same rows as the PDF answer tables, one row per try. */
export async function shareReportCsv(r: Report): Promise<void> {
  const { header, rows } = reportCsvRows(r);
  await shareCsv(`${r.fileBase}.csv`, toCsv(header, rows), r.title);
}
