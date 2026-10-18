// supabase/functions/grade-answer/index.ts
// Braille D.O.T.S. — voice answer grading  (v6)
//
// ESP32 → POST raw audio (WAV) to:
//   https://<project>.supabase.co/functions/v1/grade-answer?device=<device uuid>[&sw=<session word uuid>]
//   headers: Authorization: Bearer <anon key>, Content-Type: audio/wav,
//            x-device-secret: <secret>  (firmware v7.3+ built with DEVICE_SECRET)
//
// v6: - (AUDIT 4.1) firmware v7.2+ sends &sw=<session_word_id> of the word it
//       showed. The answer is graded against THAT word, never "whatever is
//       showing now". If it's no longer the device's current word (a Timed
//       word expired, the teacher moved on), it's saved against it anyway as
//       needs_review = true, result "review".
//     - (AUDIT 4.4) one answer per student per word (unique index, migration
//       04). A second voice answer to the same word replaces the first; if
//       the teacher already graded it by hand, their grade stands and only
//       the transcript / recording are added.
//     - (AUDIT 3.4) per-device secret (see _shared/device-auth.ts)
//
// Optional query params (for answers saved offline and uploaded later):
//   &word=CAT&session=<session uuid>&ts=<unix ms when recorded>&sw=<session word uuid>
//
// v5: firmware v7 streams the answer while the student speaks (chunked upload),
//     so it can't know the length in advance → the WAV header sizes are fixed here.
//
// v4: - each answer is linked to the exact word sending (session_word_id), so
//       sending CAT three times keeps three separate results
//     - a spelling that is ONE letter off ("C-A-D" for CAT) → review, not wrong
//       (letter names like T/D, B/P, M/N sound alike, especially from kids)
//     - a clearly different word ("dog" for CAT) is "wrong" from 0.45 confidence
//
// v3: every answer + every problem is written to system_logs (Admin → Logs)
//
// v2 changes:
//   - Exact matches are accepted at lower confidence (short words always score low)
//   - Spelled answers count: "C-A-T", "c a t", "see ay tee" → CAT
//   - Supports queued/offline answers via ?word=&session=&ts=
//
// Secrets needed: GROQ_API_KEY  (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are built in)

import { createClient } from "npm:@supabase/supabase-js@2";
import { checkDeviceSecret } from "../_shared/device-auth.ts";

const GROQ_MODEL = "whisper-large-v3";

// ── Grading thresholds ────────────────────────────────────────────────────────
const MATCH_MIN_CONFIDENCE = 0.35; // heard the RIGHT word → accept down to this
const WRONG_MIN_CONFIDENCE = 0.6;  // heard a SIMILAR word ("cap" for cat) → only "wrong" if this sure
const CLEAR_WRONG_MIN_CONFIDENCE = 0.45; // heard a CLEARLY different word ("dog") → "wrong" from here
const MAX_NO_SPEECH = 0.5;         // above this → probably silence/noise

// Whisper sometimes "hears" these in silence — never trust them as answers
const HALLUCINATIONS = ["thank you", "thanks for watching", "you", "bye", "okay", "end"];

// How Whisper tends to write spoken letter names → the actual letter
const LETTER_NAMES: Record<string, string> = {
  a: "a", ay: "a", eh: "a",
  b: "b", be: "b", bee: "b",
  c: "c", see: "c", sea: "c", cee: "c",
  d: "d", dee: "d",
  e: "e", ee: "e",
  f: "f", ef: "f", eff: "f",
  g: "g", gee: "g", ji: "g",
  h: "h", aitch: "h", haitch: "h",
  i: "i", eye: "i", aye: "i",
  j: "j", jay: "j",
  k: "k", kay: "k",
  l: "l", el: "l", elle: "l",
  m: "m", em: "m",
  n: "n", en: "n",
  o: "o", oh: "o", owe: "o",
  p: "p", pee: "p", pea: "p",
  q: "q", queue: "q", cue: "q",
  r: "r", are: "r", ar: "r",
  s: "s", es: "s", ess: "s",
  t: "t", tee: "t", tea: "t",
  u: "u", you: "u", yu: "u",
  v: "v", vee: "v",
  w: "w", doubleyou: "w",
  x: "x", ex: "x",
  y: "y", why: "y", wye: "y",
  z: "z", zee: "z", zed: "z",
};

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

// Write to system_logs (never fails the request)
async function log(
  level: "info" | "warn" | "error",
  event: string,
  message: string,
  extra: { device_id?: string | null; session_id?: string | null; meta?: Record<string, unknown> } = {},
) {
  const { error } = await supabase.from("system_logs").insert({
    level,
    source: "server",
    event,
    message: message.slice(0, 500),
    device_id: extra.device_id ?? null,
    session_id: extra.session_id || null,
    meta: extra.meta ?? {},
  });
  if (error) console.error("log failed:", error.message);
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

// "C-a t!" → "cat"
const lettersOnly = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "");

// Turns a transcript into a spelled word if EVERY token is a letter / letter name.
// "C-A-T" → "cat", "see ay tee" → "cat", "the cat" → null (not spelling)
function spelledWord(transcript: string): string | null {
  const tokens = transcript
    .toLowerCase()
    .replace(/double\s+you/g, "doubleyou")
    .split(/[^a-z]+/)
    .filter(Boolean);
  if (tokens.length < 2) return null; // one token = a normal word, not spelling
  const letters = tokens.map((t) => LETTER_NAMES[t]);
  if (letters.some((l) => !l)) return null;
  return letters.join("");
}

// Letters you'd have to change to turn a into b ("cad"→"cat" = 1, "dog"→"cat" = 3)
function editDistance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return d[a.length][b.length];
}

// Streamed WAVs carry placeholder sizes → write the real ones
function fixWavSizes(a: Uint8Array) {
  const isWav =
    a.length > 44 &&
    String.fromCharCode(a[0], a[1], a[2], a[3]) === "RIFF" &&
    String.fromCharCode(a[36], a[37], a[38], a[39]) === "data";
  if (!isWav) return;
  const v = new DataView(a.buffer, a.byteOffset, a.byteLength);
  v.setUint32(4, a.length - 8, true);
  v.setUint32(40, a.length - 44, true);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const asUuid = (v: unknown) => (typeof v === "string" && UUID_RE.test(v) ? v : null);

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const params = new URL(req.url).searchParams;
  const deviceId = asUuid(params.get("device"));
  if (!deviceId) return json({ error: "missing ?device=" }, 400);

  // ── 0. Is this really that device? (AUDIT 3.4) ───────────────────────
  const auth = await checkDeviceSecret(supabase, deviceId, req);
  if (!auth.ok) {
    await log("warn", "answer_rejected", `Answer refused: ${auth.reason}`, { device_id: deviceId });
    return json({ error: "forbidden" }, 403);
  }

  let audio = new Uint8Array(0); // (type inferred — works on every Deno version)
  try {
    audio = new Uint8Array(await req.arrayBuffer());
  } catch {
    // the device aborted the upload (e.g. button released too early)
    return json({ error: "upload aborted" }, 400);
  }
  if (audio.length < 1000) return json({ error: "audio too short" }, 400);
  fixWavSizes(audio);
  const contentType = req.headers.get("content-type") ?? "audio/wav";
  const ext = contentType.includes("mp4") || contentType.includes("m4a")
    ? "m4a"
    : contentType.includes("mpeg") ? "mp3" : "wav";

  // ── 1. Who is this device paired to? ─────────────────────────────────
  const { data: device, error: devErr } = await supabase
    .from("devices")
    .select("id, paired_student_id")
    .eq("id", deviceId)
    .maybeSingle();
  if (devErr) {
    await log("error", "grade_failed", `Device lookup failed: ${devErr.message}`, { device_id: deviceId });
    return json({ error: devErr.message }, 500);
  }
  if (!device?.paired_student_id) {
    await log("warn", "answer_rejected", "Answer from a device that isn't paired to a student", {
      device_id: deviceId,
    });
    return json({ error: "device not paired" }, 400);
  }

  // ── 2. Which word is being answered? ─────────────────────────────────
  let word = "";
  let sessionId = "";
  let responseTimeMs: number | null = null;
  let sessionWordId: string | null = null;
  let late = false; // answered a word that's no longer on the device (AUDIT 4.1)
  const queued = !!params.get("word");
  const swParam = asUuid(params.get("sw"));
  const swRow = swParam && !queued
    ? (await supabase
        .from("session_words")
        .select("id, word, session_id")
        .eq("id", swParam)
        .maybeSingle()).data
    : null;

  if (queued) {
    // Answer recorded offline and uploaded later: the device tells us the word
    word = params.get("word") ?? "";
    sessionId = params.get("session") ?? "";
    sessionWordId = asUuid(params.get("sw"));
    if (!sessionId) return json({ error: "queued answer needs &session=" }, 400);
  } else if (swRow) {
    // The device told us which word it was showing: grade against that word
    word = swRow.word ?? "";
    sessionId = swRow.session_id ?? "";
    sessionWordId = swRow.id;

    // Is it still the device's current word? (newest command for this device)
    const { data: cmd, error: cmdErr } = await supabase
      .from("device_commands")
      .select("payload, created_at")
      .eq("device_id", deviceId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (cmdErr) {
      await log("error", "grade_failed", `Command lookup failed: ${cmdErr.message}`, { device_id: deviceId });
      return json({ error: cmdErr.message }, 500);
    }
    const stillShowing = !!cmd?.payload?.chunk && cmd?.payload?.session_word_id === sessionWordId;
    late = !stillShowing;

    // Response time: from when THIS word was sent to the device
    const { data: shown } = stillShowing
      ? { data: cmd }
      : await supabase
          .from("device_commands")
          .select("created_at")
          .eq("device_id", deviceId)
          .eq("payload->>session_word_id", sessionWordId)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();
    if (shown?.created_at) {
      responseTimeMs = Math.max(0, Date.now() - new Date(shown.created_at).getTime());
    }
  } else {
    // Live answer: the most recent command for this device. If it was a
    // clear (chunk ""), there is no active word to answer.
    const { data: cmd, error: cmdErr } = await supabase
      .from("device_commands")
      .select("session_id, payload, created_at")
      .eq("device_id", deviceId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (cmdErr) {
      await log("error", "grade_failed", `Command lookup failed: ${cmdErr.message}`, { device_id: deviceId });
      return json({ error: cmdErr.message }, 500);
    }

    const chunk: string = cmd?.payload?.chunk ?? "";
    word = cmd?.payload?.word ?? "";
    sessionId = cmd?.session_id ?? "";
    sessionWordId = asUuid(cmd?.payload?.session_word_id);
    if (!cmd || !chunk || !word) {
      await log("warn", "answer_rejected", "Answer received but no word was on the display", {
        device_id: deviceId,
        session_id: cmd?.session_id,
      });
      return json({ result: "no_word", error: "no active word" });
    }
    responseTimeMs = Math.max(0, Date.now() - new Date(cmd.created_at).getTime());
  }

  const expected = lettersOnly(word);
  if (!expected) return json({ error: "empty word" }, 400);

  // ── 3. Save the recording ─────────────────────────────────────────────
  const stamp = params.get("ts") ?? String(Date.now());
  const audioPath =
    `${sessionId}/${device.paired_student_id}/${stamp}_${expected}.${ext}`;
  const { error: upErr } = await supabase.storage
    .from("answers")
    .upload(audioPath, audio, { contentType, upsert: true });
  if (upErr) {
    console.error("storage upload failed:", upErr.message);
    await log("warn", "recording_not_saved", `Recording upload failed: ${upErr.message}`, {
      device_id: deviceId,
      session_id: sessionId,
      meta: { path: audioPath },
    });
  }

  // ── 4. Transcribe with Groq Whisper ──────────────────────────────────
  const form = new FormData();
  form.append("file", new Blob([audio], { type: contentType }), `answer.${ext}`);
  form.append("model", GROQ_MODEL);
  form.append("language", "en");
  form.append("temperature", "0");
  form.append("response_format", "verbose_json");
  // Light context only: naming the exact word would bias Whisper toward
  // "correct" even when the child says something else.
  form.append(
    "prompt",
    "A young child reads one English word out loud, or spells it letter by letter.",
  );

  const groqRes = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${Deno.env.get("GROQ_API_KEY")}` },
    body: form,
  });
  if (!groqRes.ok) {
    const detail = await groqRes.text();
    console.error("groq error:", detail);
    await log("error", "grade_failed", `Speech-to-text failed (HTTP ${groqRes.status})`, {
      device_id: deviceId,
      session_id: sessionId,
      meta: { word: word.toUpperCase(), status: groqRes.status, detail: detail.slice(0, 300), audio_path: audioPath },
    });
    return json({ error: "transcription failed", detail }, 502);
  }
  const stt = await groqRes.json();

  const transcript: string = (stt.text ?? "").trim();
  const segments: { avg_logprob: number; no_speech_prob: number }[] = stt.segments ?? [];
  const avgLogprob = segments.length
    ? segments.reduce((s, x) => s + x.avg_logprob, 0) / segments.length
    : -5;
  const noSpeech = segments.length ? Math.max(...segments.map((x) => x.no_speech_prob)) : 1;
  const confidence = Math.round(Math.exp(avgLogprob) * 100) / 100; // 0..1

  // ── 5. Grade ─────────────────────────────────────────────────────────
  const heardWords = transcript.toLowerCase().split(/\s+/).map(lettersOnly).filter(Boolean);
  const spelled = spelledWord(transcript);

  const saidWord = heardWords.includes(expected);           // "cat" / "it's cat"
  const saidLetters = lettersOnly(transcript) === expected; // "c a t" / "C-A-T"
  const saidSpelled = spelled === expected;                 // "see ay tee"
  const isCorrect = saidWord || saidLetters || saidSpelled;

  const cleanText = transcript.toLowerCase().replace(/[^a-z ]/g, "").trim();
  const silence = !transcript || noSpeech > MAX_NO_SPEECH;
  const hallucination = !isCorrect && HALLUCINATIONS.includes(cleanText);

  let result: "correct" | "wrong" | "review";
  if (silence || hallucination) {
    result = "review"; // nothing usable heard — let the teacher listen
  } else if (isCorrect) {
    result = confidence >= MATCH_MIN_CONFIDENCE ? "correct" : "review";
  } else {
    // What did the child say instead? (a spelled word, or a single word)
    const heard = spelled ?? (heardWords.length === 1 ? heardWords[0] : null);
    const close = heard !== null && editDistance(heard, expected) <= 1;
    if (spelled !== null && close) {
      result = "review"; // one letter off while spelling — likely a mishearing
    } else if (close) {
      result = confidence >= WRONG_MIN_CONFIDENCE ? "wrong" : "review";
    } else {
      result = confidence >= CLEAR_WRONG_MIN_CONFIDENCE ? "wrong" : "review";
    }
  }
  if (late) result = "review"; // graded against the right word, but the teacher checks it
  const needsReview = result === "review";

  // ── 6. Save attempt (app shows it live via Realtime) ─────────────────
  const attempt = {
    student_id: device.paired_student_id,
    session_id: sessionId,
    session_word_id: sessionWordId,
    word: word.toUpperCase(),
    is_correct: isCorrect,
    response_time_ms: responseTimeMs,
    transcript,
    confidence,
    audio_path: audioPath,
    needs_review: needsReview,
    graded_by: "auto",
  };
  let { error: insErr } = await supabase.from("word_attempts").insert(attempt);

  // 23505 = this student already has an answer for this word (unique index)
  let teacherGradeKept = false;
  if (insErr?.code === "23505" && sessionWordId) {
    const { data: prev } = await supabase
      .from("word_attempts")
      .select("id, graded_by")
      .eq("session_word_id", sessionWordId)
      .eq("student_id", device.paired_student_id)
      .maybeSingle();
    if (prev) {
      teacherGradeKept = prev.graded_by === "teacher";
      const patch = teacherGradeKept
        ? // the teacher graded it by hand: their grade stands, add what we heard
          { transcript, confidence, audio_path: audioPath, response_time_ms: responseTimeMs }
        : // an earlier voice answer: the newest one counts
          { ...attempt, attempted_at: new Date().toISOString() };
      ({ error: insErr } = await supabase.from("word_attempts").update(patch).eq("id", prev.id));
    }
  }
  if (insErr) {
    await log("error", "grade_failed", `Could not save the answer: ${insErr.message}`, {
      device_id: deviceId,
      session_id: sessionId,
      meta: { word: word.toUpperCase(), transcript, result },
    });
    return json({ error: insErr.message, transcript }, 500);
  }

  await log(
    "info",
    "answer_graded",
    `${word.toUpperCase()} → ${result}${transcript ? ` (heard "${transcript}")` : " (nothing heard)"}`,
    {
      device_id: deviceId,
      session_id: sessionId,
      meta: {
        word: word.toUpperCase(),
        result,
        transcript,
        confidence,
        no_speech: Math.round(noSpeech * 100) / 100,
        spelled: saidSpelled,
        queued,
        late,
        teacher_grade_kept: teacherGradeKept,
        session_word_id: sessionWordId,
        student_id: device.paired_student_id,
        audio_path: audioPath,
      },
    },
  );

  return json({
    result,
    word: word.toUpperCase(),
    transcript,
    confidence,
    spelled: saidSpelled || (saidLetters && !saidWord),
    queued,
    late,
  });
});