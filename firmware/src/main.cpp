/*
 * ================================================================
 * BRAILLE D.O.T.S. — FIRMWARE v6.11 (Supabase Realtime + Voice)
 * File: src/main.cpp
 *
 * v6.11: pairing sounds (paired / unpaired); connection sounds now optional
 * v6.10: connection sounds (disconnected / reconnected)
 * v6.9: session sounds (started, paused, resumed, finished)
 * v6.8: speaker feedback sounds (ready, new word, rec on/off,
 *       correct, wrong, review, error) on MAX98357A / I2S1
 * v6.7: per-button wiring (ANSWER → GND, NEXT/BACK → 3.3V)
 * v6.6: debounced buttons (noise on the button lines was firing fake presses)
 * v6.5: buttons wired to 3.3V → internal pull-down (pressed = HIGH);
 *       mic reads RIGHT slot (INMP441 L/R=GND quirk)
 * v6.4: voice answer memory fix — realtime socket is paused during
 *       the answer upload (ESP32 can't hold 2 TLS connections + audio)
 * v6.3: hold ANSWER → record (INMP441) → upload → auto-grade
 * v6.2: 5 cells (5x 74HC595 daisy-chained), buttons NEXT=16 BACK=14 ANSWER=13
 * v6.1: safety fixes (real kill-switch, 60s firmware timeout,
 *       coils off on disconnect), postgres_changes subscription
 *
 * Commands arrive via: INSERT into device_commands
 *   row.device_id          = this device's UUID
 *   row.payload.chunk      = "HELLO" (up to 5 letters) or "" (kill-switch)
 *
 * ⚠  UNPLUG GPIO5 (PIN_LATCH) before every upload!
 * ================================================================
 */

#include "secrets.h"   // Wi-Fi name + password (not on GitHub)
#include <Arduino.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <WebSocketsClient.h>
#include <ArduinoJson.h>
#include <HTTPClient.h>
#include <driver/i2s.h>

// ── Microphone (INMP441 on I2S0) ──────────────────────────────
#define MIC_PORT        I2S_NUM_0
#define MIC_SCK         32
#define MIC_WS          33
#define MIC_SD          35
#define MIC_CHANNEL     I2S_CHANNEL_FMT_ONLY_RIGHT // L/R tied to GND (ESP32 quirk: data lands in the RIGHT slot)
#define MIC_SHIFT       14      // 32-bit mic sample → 16-bit. Lower = louder (13 = 2x louder)
#define SAMPLE_RATE     16000   // what Whisper expects
#define MAX_REC_SEC     2       // longest answer kept (64 KB of RAM)
#define MIN_REC_MS      300     // shorter presses are ignored

// ── Speaker (MAX98357A on I2S1) ───────────────────────────────
#define SPK_PORT        I2S_NUM_1
#define SPK_BCLK        27
#define SPK_LRC         26
#define SPK_DIN         22
#define SPK_RATE        16000
#define SPK_VOLUME      0.25f   // 0.0 – 1.0  (classroom-friendly default)
#define SPK_TEST_ON_BOOT 1      // 1 = play a 2-second test tone at boot (set 0 when done)
#define CONNECTION_SOUNDS 0     // 1 = also beep on Wi-Fi/server disconnect & reconnect

uint8_t* recBuf      = nullptr; // 44-byte WAV header + audio
size_t   recCapacity = 0;       // audio bytes that fit in recBuf

// ── WiFi credentials (fill in) ────────────────────────────────

// ── Supabase config ───────────────────────────────────────────
#define SUPABASE_HOST "nacknvkbcjxuthtycdzj.supabase.co"
#define SUPABASE_KEY "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5hY2tudmtiY2p4dXRodHljZHpqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkxMTU3NjcsImV4cCI6MjA5NDY5MTc2N30.tFeY8qDCWA43dYHVv72OPfDcp3dSzNB06mSYc1Hgx9I"

// ── Device pairing code ───────────────────────────────────────
// Type this code in the app: Student → Pair Device.
// Set per device in platformio.ini ([env:dots1], [env:dots2], ...).
#ifndef DEVICE_CODE
#define DEVICE_CODE "DOTS-0001"
#endif

char deviceId[40] = ""; // UUID from the devices table, fetched at boot
char pairedStudent[40] = ""; // student UUID this device is paired to ("" = none)
bool registerDevice();  // defined below

#define REALTIME_PATH "/realtime/v1/websocket?apikey=" SUPABASE_KEY "&vsn=1.0.0"
#define REALTIME_PORT 443

// Channels
#define CHAN_COMMANDS "realtime:public:device_commands"
#define CHAN_EVENTS "realtime:public:device_events"

// ── Shift register pins ───────────────────────────────────────
#define PIN_DATA 23
#define PIN_CLOCK 18
#define PIN_LATCH 5 // ⚠ UNPLUG BEFORE UPLOAD
#define PIN_OE 25   // Output Enable (active LOW, PWM)
#define PIN_LED 2

// ── Button pins ───────────────────────────────────────────────
#define BTN_NEXT 16
#define BTN_BACK 14
#define BTN_ANSWER 13

// ── How each button is wired ──────────────────────────────────
// 1 = button connects the pin to GND   (pull-up,   pressed = LOW)
// 0 = button connects the pin to 3.3V  (pull-down, pressed = HIGH)
// GND wiring is preferred: stronger internal pull, less noise.
#define NEXT_TO_GND    0
#define BACK_TO_GND    0
#define ANSWER_TO_GND  1

#define NUM_CELLS 5 // 5x 74HC595 + 5x ULN2803, 6 solenoids each

// ── Timing ───────────────────────────────────────────────────
#define PUNCH_MS 100
#define HEARTBEAT_MS 25000
#define SAFETY_MS 60000UL // firmware-side kill-switch

#define OE_FULL 0
#define OE_HOLD 140
#define OE_OFF 255

// ── Braille patterns ──────────────────────────────────────────
#define DOT1 (1 << 0)
#define DOT2 (1 << 1)
#define DOT3 (1 << 2)
#define DOT4 (1 << 3)
#define DOT5 (1 << 4)
#define DOT6 (1 << 5)

const uint8_t BRAILLE[26] = {
    /* A */ DOT1,
    /* B */ DOT1 | DOT2,
    /* C */ DOT1 | DOT4,
    /* D */ DOT1 | DOT4 | DOT5,
    /* E */ DOT1 | DOT5,
    /* F */ DOT1 | DOT2 | DOT4,
    /* G */ DOT1 | DOT2 | DOT4 | DOT5,
    /* H */ DOT1 | DOT2 | DOT5,
    /* I */ DOT2 | DOT4,
    /* J */ DOT2 | DOT4 | DOT5,
    /* K */ DOT1 | DOT3,
    /* L */ DOT1 | DOT2 | DOT3,
    /* M */ DOT1 | DOT3 | DOT4,
    /* N */ DOT1 | DOT3 | DOT4 | DOT5,
    /* O */ DOT1 | DOT3 | DOT5,
    /* P */ DOT1 | DOT2 | DOT3 | DOT4,
    /* Q */ DOT1 | DOT2 | DOT3 | DOT4 | DOT5,
    /* R */ DOT1 | DOT2 | DOT3 | DOT5,
    /* S */ DOT2 | DOT3 | DOT4,
    /* T */ DOT2 | DOT3 | DOT4 | DOT5,
    /* U */ DOT1 | DOT3 | DOT6,
    /* V */ DOT1 | DOT2 | DOT3 | DOT6,
    /* W */ DOT2 | DOT4 | DOT5 | DOT6,
    /* X */ DOT1 | DOT3 | DOT4 | DOT6,
    /* Y */ DOT1 | DOT3 | DOT4 | DOT5 | DOT6,
    /* Z */ DOT1 | DOT3 | DOT5 | DOT6,
};

// ── WebSocket client ──────────────────────────────────────────
WebSocketsClient wsClient;
bool wsConnected = false;
bool rtPaused = false; // socket closed ON PURPOSE (answer upload) — keep the word
bool rtDropped = false; // connection was LOST (not paused) — play "reconnected" when back
unsigned long lastHeartbeat = 0;
int joinRef = 1;

// ── State machine ─────────────────────────────────────────────
enum State
{
  PUNCHING,
  HOLDING
};
State devState = HOLDING;
unsigned long stateTimer = 0;

// ── Safety timer ──────────────────────────────────────────────
bool energized = false;
unsigned long energizedAt = 0;

// ── Chunk buffer ──────────────────────────────────────────────
char chunkBuf[6] = "";
int chunkLen = 0;



// ── Button debouncing ─────────────────────────────────────────
// A press/release only counts if the pin stays steady this long.
// Filters out electrical noise and contact bounce.
#define BTN_STABLE_MS  40   // must stay pressed/released this long to count
#define RELEASE_MS     80   // while recording: released this long = stop

struct Button
{
  uint8_t pin;
  const char *name;
  bool toGnd;              // wiring (see *_TO_GND above)
  int stable;              // last accepted level
  int raw;                 // last raw reading
  unsigned long changedAt; // when raw last changed
};
#define PRESSED_LVL(b)  ((b).toGnd ? LOW : HIGH)
#define RELEASED_LVL(b) ((b).toGnd ? HIGH : LOW)

Button btnNext   = {BTN_NEXT,   "NEXT  ", NEXT_TO_GND,   NEXT_TO_GND ? HIGH : LOW,   NEXT_TO_GND ? HIGH : LOW,   0};
Button btnBack   = {BTN_BACK,   "BACK  ", BACK_TO_GND,   BACK_TO_GND ? HIGH : LOW,   BACK_TO_GND ? HIGH : LOW,   0};
Button btnAnswer = {BTN_ANSWER, "ANSWER", ANSWER_TO_GND, ANSWER_TO_GND ? HIGH : LOW, ANSWER_TO_GND ? HIGH : LOW, 0};

void buttonInit(Button &b)
{
  pinMode(b.pin, b.toGnd ? INPUT_PULLUP : INPUT_PULLDOWN);
}

bool isDown(Button &b) { return digitalRead(b.pin) == PRESSED_LVL(b); }

// Returns true exactly once per real press (on the press edge).
bool buttonPressed(Button &b)
{
  int r = digitalRead(b.pin);
  unsigned long t = millis();
  if (r != b.raw)
  {
    b.raw = r;
    b.changedAt = t;
  }
  if (r != b.stable && t - b.changedAt >= BTN_STABLE_MS)
  {
    b.stable = r;
    Serial.printf("[PIN] %s (GPIO %d): %s\n", b.name, b.pin,
                  r == PRESSED_LVL(b) ? "PRESSED" : "released");
    return r == PRESSED_LVL(b);
  }
  return false;
}

// Blocks until the button has been released steadily (max 5s).
void waitForRelease(Button &b)
{
  unsigned long relSince = 0, start = millis();
  while (millis() - start < 5000)
  {
    if (!isDown(b))
    {
      if (!relSince)
        relSince = millis();
      else if (millis() - relSince >= RELEASE_MS)
        return;
    }
    else
      relSince = 0;
    delay(5);
  }
}

// ═════════════════════════════════════════════════════════════
// SPEAKER — feedback sounds (generated, no audio files)
// ═════════════════════════════════════════════════════════════

bool spkReady = false;

enum Wave : uint8_t { SINE, SQUARE };

struct Note
{
  float freq;    // Hz, 0 = silence
  uint16_t ms;   // length
  Wave wave;
  bool decay;    // true = bell-like fade out, false = steady
};

void spkInit()
{
  i2s_config_t cfg = {};
  cfg.mode = (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_TX);
  cfg.sample_rate = SPK_RATE;
  cfg.bits_per_sample = I2S_BITS_PER_SAMPLE_16BIT;
  cfg.channel_format = I2S_CHANNEL_FMT_RIGHT_LEFT; // same sample on both sides
  cfg.communication_format = I2S_COMM_FORMAT_STAND_I2S;
  cfg.intr_alloc_flags = ESP_INTR_FLAG_LEVEL1;
  cfg.dma_buf_count = 6;
  cfg.dma_buf_len = 256;
  cfg.use_apll = false;
  cfg.tx_desc_auto_clear = true; // output silence when idle (no hum)

  i2s_pin_config_t pins = {};
  pins.bck_io_num = SPK_BCLK;
  pins.ws_io_num = SPK_LRC;
  pins.data_out_num = SPK_DIN;
  pins.data_in_num = I2S_PIN_NO_CHANGE;

  if (i2s_driver_install(SPK_PORT, &cfg, 0, NULL) != ESP_OK ||
      i2s_set_pin(SPK_PORT, &pins) != ESP_OK)
  {
    Serial.println("[SPK] ERROR: I2S init failed");
    return;
  }
  i2s_zero_dma_buffer(SPK_PORT);
  spkReady = true;
  Serial.println("[SPK] MAX98357A ready on I2S1");
}

void playNote(const Note &n)
{
  const uint32_t total = (uint32_t)SPK_RATE * n.ms / 1000;
  const uint32_t ramp = SPK_RATE * 5 / 1000; // 5ms fade in/out → no clicks
  int16_t buf[256];                           // 128 stereo frames
  float phase = 0.0f;
  const float step = 2.0f * PI * n.freq / SPK_RATE;
  uint32_t i = 0;

  while (i < total)
  {
    int frames = 0;
    for (; frames < 128 && i < total; frames++, i++)
    {
      float v = 0.0f;
      if (n.freq > 0)
      {
        float sn = sinf(phase);
        v = (n.wave == SQUARE) ? (sn >= 0 ? 0.5f : -0.5f) : sn; // squares are louder
        phase += step;
        if (phase > 2.0f * PI)
          phase -= 2.0f * PI;

        float env = 1.0f;
        if (n.decay)
          env = expf(-4.0f * (float)i / total); // bell fade
        if (i < ramp)
          env *= (float)i / ramp;
        if (total - i < ramp)
          env *= (float)(total - i) / ramp;
        v *= env;
      }
      int16_t s16 = (int16_t)(v * SPK_VOLUME * 32767.0f);
      buf[frames * 2] = s16;     // left  (the amp plays this one)
      buf[frames * 2 + 1] = s16; // right
    }
    size_t written;
    i2s_write(SPK_PORT, buf, frames * 4, &written, portMAX_DELAY);
  }
}

void playMelody(const Note *notes, size_t count)
{
  if (!spkReady)
  {
    Serial.println("[SPK] skipped — speaker not initialised");
    return;
  }
  Serial.printf("[SPK] playing %u note(s)\n", (unsigned)count);
  for (size_t k = 0; k < count; k++)
    playNote(notes[k]);
  // let the last DMA buffers drain before returning
  delay(30);
}

// ── The sound set ─────────────────────────────────────────────
const Note SND_CORRECT[] = {{1047, 90, SINE, false}, {1319, 90, SINE, false}, {1568, 320, SINE, true}};
const Note SND_WRONG[]   = {{150, 380, SQUARE, false}};
const Note SND_REVIEW[]  = {{660, 110, SINE, false}, {0, 70, SINE, false}, {660, 110, SINE, false}};
const Note SND_REC_ON[]  = {{1500, 60, SINE, false}};
const Note SND_REC_OFF[] = {{800, 60, SINE, false}};
const Note SND_NEWWORD[] = {{880, 120, SINE, true}, {1320, 220, SINE, true}};
const Note SND_ERROR[]   = {{250, 120, SQUARE, false}, {0, 80, SINE, false},
                            {250, 120, SQUARE, false}, {0, 80, SINE, false},
                            {250, 120, SQUARE, false}};
const Note SND_READY[]   = {{523, 100, SINE, false}, {659, 100, SINE, false}, {784, 220, SINE, true}};
// Connection status
const Note SND_DISCONNECTED[] = {{659, 120, SINE, false}, {523, 120, SINE, false}, {392, 320, SINE, true}};
const Note SND_RECONNECTED[]  = {{523, 100, SINE, false}, {784, 220, SINE, true}};
// Pairing (teacher assigns / removes this device for a student)
const Note SND_PAIRED[]   = {{784, 150, SINE, false}, {1175, 380, SINE, true}};
const Note SND_UNPAIRED[] = {{1175, 150, SINE, false}, {784, 380, SINE, true}};
// Session events (sent by the teacher's app)
const Note SND_START[]    = {{660, 100, SINE, false}, {880, 100, SINE, false}, {1320, 260, SINE, true}};
const Note SND_PAUSED[]   = {{784, 150, SINE, false}, {523, 280, SINE, true}};
const Note SND_RESUMED[]  = {{523, 150, SINE, false}, {784, 280, SINE, true}};
const Note SND_FINISHED[] = {{523, 120, SINE, false}, {659, 120, SINE, false},
                             {784, 120, SINE, false}, {1047, 480, SINE, true}};

#define PLAY(snd) playMelody(snd, sizeof(snd) / sizeof(snd[0]))

// ═════════════════════════════════════════════════════════════
// HARDWARE
// ═════════════════════════════════════════════════════════════

void oeFullPower() { analogWrite(PIN_OE, OE_FULL); }
void oeHoldPower() { analogWrite(PIN_OE, OE_HOLD); }
void oeOff() { analogWrite(PIN_OE, OE_OFF); }

// Push one pattern per cell down the daisy chain.
// The FIRST byte shifted ends up in the LAST chip, so send cell 5 first.
// Dots 1-6 are on Q2-Q7, hence the << 2.  Push-type: 1 = coil ON = dot UP.
void shiftCells(const uint8_t *pats)
{
  digitalWrite(PIN_LATCH, LOW);
  for (int c = NUM_CELLS - 1; c >= 0; c--)
    shiftOut(PIN_DATA, PIN_CLOCK, MSBFIRST, (pats[c] & 0x3F) << 2);
  digitalWrite(PIN_LATCH, HIGH);
}

// Every coil in every cell OFF
void allCoilsOff()
{
  oeOff();
  uint8_t zeros[NUM_CELLS] = {0};
  shiftCells(zeros);
}

void clearDisplay()
{
  allCoilsOff();
  digitalWrite(PIN_LED, LOW);
  chunkBuf[0] = '\0';
  chunkLen = 0;
  devState = HOLDING; // stop punch->hold from re-enabling OE
  energized = false;
  Serial.println("[SAFETY] All coils OFF");
}

// Show the whole chunk at once: letter i on cell i
void showChunk()
{
  uint8_t target[NUM_CELLS] = {0};
  uint8_t building[NUM_CELLS] = {0};

  for (int i = 0; i < chunkLen && i < NUM_CELLS; i++)
    target[i] = BRAILLE[chunkBuf[i] - 'A'];

  Serial.printf("[SHOW] '%s' on %d cell(s)\n", chunkBuf, chunkLen);

  // Staggered firing — raise one dot at a time, 8ms apart, to avoid 5V sag
  shiftCells(building);
  oeFullPower();
  delay(10);
  for (int c = 0; c < NUM_CELLS; c++)
  {
    for (int d = 0; d < 6; d++)
    {
      if (target[c] & (1 << d))
      {
        building[c] |= (1 << d);
        shiftCells(building);
        delay(8);
      }
    }
  }

  digitalWrite(PIN_LED, HIGH);
  devState = PUNCHING;
  stateTimer = millis();
}

// ═════════════════════════════════════════════════════════════
// SUPABASE REALTIME — SEND
// ═════════════════════════════════════════════════════════════

void rtSend(const String &json)
{
  if (wsConnected)
  {
    wsClient.sendTXT(json.c_str());
    Serial.printf("→ Supabase: %s\n", json.c_str());
  }
  else
  {
    Serial.println("[RT] Not connected — message dropped");
  }
}

// Listen for INSERTs on device_commands, filtered to THIS device
void joinCommandsChannel()
{
  JsonDocument msg;
  msg["topic"] = CHAN_COMMANDS;
  msg["event"] = "phx_join";
  msg["ref"] = String(joinRef++);

  JsonObject cfg = msg["payload"]["config"].to<JsonObject>();
  cfg["broadcast"]["self"] = false;
  cfg["presence"]["key"] = "";
  cfg["private"] = false;

  JsonObject pc = cfg["postgres_changes"].add<JsonObject>();
  pc["event"] = "INSERT";
  pc["schema"] = "public";
  pc["table"] = "device_commands";
  pc["filter"] = String("device_id=eq.") + deviceId;

  // Also watch our own row in "devices" → pairing changes
  JsonObject pd = cfg["postgres_changes"].add<JsonObject>();
  pd["event"] = "UPDATE";
  pd["schema"] = "public";
  pd["table"] = "devices";
  pd["filter"] = String("id=eq.") + deviceId;

  msg["payload"]["access_token"] = SUPABASE_KEY;

  String out;
  serializeJson(msg, out);
  rtSend(out);
}

// Broadcast channel for button events (unchanged behaviour)
void joinEventsChannel()
{
  String msg = "{\"topic\":\"" CHAN_EVENTS "\","
               "\"event\":\"phx_join\","
               "\"payload\":{\"config\":{\"broadcast\":{\"self\":false}}},"
               "\"ref\":\"" +
               String(joinRef++) + "\"}";
  rtSend(msg);
}

void sendHeartbeat()
{
  rtSend("{\"topic\":\"phoenix\",\"event\":\"heartbeat\",\"payload\":{},\"ref\":\"hb\"}");
}

void publishEvent(const char *eventType, int posIndex, int totalLen)
{
  char payload[256];
  snprintf(payload, sizeof(payload),
           "{\"device_id\":\"%s\",\"event_type\":\"%s\","
           "\"letter_index\":%d,\"chunk_length\":%d}",
           deviceId, eventType, posIndex, totalLen);

  String msg = "{\"topic\":\"" CHAN_EVENTS "\","
               "\"event\":\"broadcast\","
               "\"payload\":{\"type\":\"broadcast\",\"event\":\"device_event\","
               "\"payload\":" +
               String(payload) + "},"
                                 "\"ref\":\"" +
               String(joinRef++) + "\"}";
  rtSend(msg);
}

// ═════════════════════════════════════════════════════════════
// SUPABASE REALTIME — RECEIVE
// ═════════════════════════════════════════════════════════════

// Incoming shape:
// { "event":"postgres_changes",
//   "payload":{ "data":{ "type":"INSERT",
//                        "record":{ "device_id":"<uuid>",
//                                   "payload":{ "chunk":"HELLO", ... } } } } }
// Teacher paired / unpaired this device in the app
void handleDeviceUpdate(JsonDocument &doc)
{
  JsonObject row = doc["payload"]["data"]["record"];
  if (row.isNull())
    return;
  const char *ps = row["paired_student_id"] | "";

  if (strcmp(ps, pairedStudent) == 0)
    return; // e.g. our own status update — pairing unchanged

  if (ps[0])
  {
    Serial.printf("[PAIR] Paired to student %s\n", ps);
    PLAY(SND_PAIRED);
  }
  else
  {
    Serial.println("[PAIR] Unpaired");
    if (chunkLen > 0)
      clearDisplay(); // no longer controlled by a session — drop the coils
    PLAY(SND_UNPAIRED);
  }
  strlcpy(pairedStudent, ps, sizeof(pairedStudent));
}

void handleCommand(JsonDocument &doc)
{
  JsonObject data = doc["payload"]["data"];
  if (data.isNull())
    return;

  JsonObject row = data["record"];
  if (row.isNull())
    row = data["new"]; // fallback, older format
  if (row.isNull())
  {
    Serial.println("[CMD] No row in message");
    return;
  }

  const char *targetId = row["device_id"];
  if (!targetId || strcmp(targetId, deviceId) != 0)
  {
    Serial.println("[CMD] Ignored — not for this device");
    return;
  }

  const char *chunk = row["payload"]["chunk"];
  const char *ctype = row["command_type"] | "display_chunk";

  // ── KILL-SWITCH (also used for session events) ─────────────
  if (!chunk || !chunk[0])
  {
    Serial.printf("[CMD] Kill-switch received (%s)\n", ctype);
    clearDisplay();

    if (strcmp(ctype, "session_started") == 0)
      PLAY(SND_START);
    else if (strcmp(ctype, "session_paused") == 0)
      PLAY(SND_PAUSED);
    else if (strcmp(ctype, "session_resumed") == 0)
      PLAY(SND_RESUMED);
    else if (strcmp(ctype, "session_finished") == 0)
      PLAY(SND_FINISHED);
    return;
  }

  // ── Load chunk (uppercase, A-Z only, max 5) ────────────────
  chunkLen = 0;
  for (int i = 0; chunk[i] && chunkLen < 5; i++)
  {
    char c = toupper((unsigned char)chunk[i]);
    if (c >= 'A' && c <= 'Z')
      chunkBuf[chunkLen++] = c;
  }
  chunkBuf[chunkLen] = '\0';

  Serial.printf("[CMD] Chunk received: '%s' (%d letters)\n", chunkBuf, chunkLen);

  if (chunkLen == 0)
  {
    clearDisplay();
    return;
  }

  energized = true;
  energizedAt = millis(); // 60s firmware timer starts per new chunk
  showChunk();
  PLAY(SND_NEWWORD); // "a new word is ready"

}

void onWsEvent(WStype_t type, uint8_t *payload, size_t length)
{
  switch (type)
  {

  case WStype_CONNECTED:
    wsConnected = true;
    rtPaused = false;
    Serial.println("\n[RT] Connected to Supabase Realtime!");
    {
      static bool firstConnect = true;
      if (firstConnect)
      {
        firstConnect = false;
        PLAY(SND_READY); // device is ready for the session
      }
      else if (rtDropped)
      {
#if CONNECTION_SOUNDS
        PLAY(SND_RECONNECTED); // back online after a real drop
#endif
      }
      // (after an answer upload pause: silent — that's routine)
      rtDropped = false;
    }
    // (No registerDevice() here: a 2nd TLS connection while this one is
    //  open runs out of RAM. Boot registration already set status.)
    joinCommandsChannel();
    joinEventsChannel();
    lastHeartbeat = millis();
    break;

  case WStype_DISCONNECTED:
  {
    bool wasConnected = wsConnected; // reconnect attempts also fire this event
    wsConnected = false;
    if (rtPaused)
    {
      // Planned pause for an answer upload: keep the word on the display.
      // The 60s firmware timer still protects the coils.
      Serial.println("[RT] Paused for answer upload");
    }
    else
    {
      if (wasConnected)
      {
        Serial.println("[RT] Disconnected. Will retry...");
        rtDropped = true;
        clearDisplay();         // real drop: no way to receive the kill-switch
#if CONNECTION_SOUNDS
        PLAY(SND_DISCONNECTED); // once per drop, not on every retry
#endif
      }
      else if (chunkLen > 0)
      {
        clearDisplay();
      }
    }
    break;
  }

  case WStype_TEXT:
  {
    Serial.printf("← Supabase: %.*s\n", (int)length, (char *)payload);

    JsonDocument doc;
    DeserializationError err = deserializeJson(doc, payload, length);
    if (err)
    {
      Serial.printf("[ERR] JSON parse failed: %s\n", err.c_str());
      break;
    }

    const char *event = doc["event"];
    if (!event)
      break;

    if (strcmp(event, "phx_reply") == 0)
    {
      const char *status = doc["payload"]["status"];
      Serial.printf("[RT] Join/reply status: %s\n", status ? status : "?");
      break;
    }

    if (strcmp(event, "postgres_changes") == 0)
    {
      const char *table = doc["payload"]["data"]["table"] | "";
      if (strcmp(table, "devices") == 0)
        handleDeviceUpdate(doc);
      else
        handleCommand(doc);
    }
    break;
  }

  case WStype_ERROR:
    Serial.println("[RT] WebSocket error");
    if (!rtPaused)
      clearDisplay();
    break;

  default:
    break;
  }
}

// ═════════════════════════════════════════════════════════════
// DEVICE REGISTRATION (REST)
// ═════════════════════════════════════════════════════════════

// Upserts this device into the devices table by DEVICE_CODE,
// sets status = "connected", and stores the row's UUID in deviceId.
// Keeps paired_student_id untouched, so app pairing still works.
bool registerDevice()
{
  WiFiClientSecure client;
  client.setInsecure(); // prototype: skip certificate check
  HTTPClient http;

  String url = String("https://") + SUPABASE_HOST +
               "/rest/v1/devices?on_conflict=device_code&select=id,paired_student_id";
  if (!http.begin(client, url))
    return false;

  http.addHeader("apikey", SUPABASE_KEY);
  http.addHeader("Authorization", String("Bearer ") + SUPABASE_KEY);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("Prefer", "resolution=merge-duplicates,return=representation");

  String body = String("{\"device_code\":\"") + DEVICE_CODE +
                "\",\"status\":\"connected\"}";
  int code = http.POST(body);
  String resp = http.getString();
  http.end();

  Serial.printf("[REG] HTTP %d: %s\n", code, resp.c_str());
  if (code < 200 || code >= 300)
    return false;

  JsonDocument doc;
  if (deserializeJson(doc, resp))
    return false;
  const char *id = doc[0]["id"];
  if (!id)
    return false;

  strlcpy(deviceId, id, sizeof(deviceId));
  const char *ps = doc[0]["paired_student_id"] | "";
  strlcpy(pairedStudent, ps, sizeof(pairedStudent));
  Serial.printf("[DEV] Paired to student: %s\n", pairedStudent[0] ? pairedStudent : "(none)");
  return true;
}

// ═════════════════════════════════════════════════════════════
// VOICE ANSWER (hold ANSWER → record → upload → grade)
// ═════════════════════════════════════════════════════════════

void micInit()
{
  // Grab the biggest buffer we can (MAX_REC_SEC → ... → 1s)
  for (int sec = MAX_REC_SEC; sec >= 1 && !recBuf; sec--)
  {
    recCapacity = (size_t)SAMPLE_RATE * 2 * sec;
    recBuf = (uint8_t *)malloc(44 + recCapacity);
  }
  if (!recBuf)
  {
    Serial.println("[MIC] ERROR: not enough RAM for recording buffer");
    recCapacity = 0;
    return;
  }
  Serial.printf("[MIC] Buffer ready: %u ms max\n",
                (unsigned)(recCapacity * 1000 / (SAMPLE_RATE * 2)));

  i2s_config_t cfg = {};
  cfg.mode = (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_RX);
  cfg.sample_rate = SAMPLE_RATE;
  cfg.bits_per_sample = I2S_BITS_PER_SAMPLE_32BIT;
  cfg.channel_format = MIC_CHANNEL;
  cfg.communication_format = I2S_COMM_FORMAT_STAND_I2S;
  cfg.intr_alloc_flags = ESP_INTR_FLAG_LEVEL1;
  cfg.dma_buf_count = 8;
  cfg.dma_buf_len = 256;
  cfg.use_apll = false;

  i2s_pin_config_t pins = {};
  pins.bck_io_num = MIC_SCK;
  pins.ws_io_num = MIC_WS;
  pins.data_out_num = I2S_PIN_NO_CHANGE;
  pins.data_in_num = MIC_SD;

  if (i2s_driver_install(MIC_PORT, &cfg, 0, NULL) != ESP_OK ||
      i2s_set_pin(MIC_PORT, &pins) != ESP_OK)
  {
    Serial.println("[MIC] ERROR: I2S init failed");
    return;
  }
  Serial.println("[MIC] INMP441 ready on I2S0");
}

void writeWavHeader(uint8_t *h, uint32_t dataBytes)
{
  const uint32_t byteRate = SAMPLE_RATE * 2;
  auto w32 = [&](int o, uint32_t v)
  { h[o] = v; h[o + 1] = v >> 8; h[o + 2] = v >> 16; h[o + 3] = v >> 24; };
  auto w16 = [&](int o, uint16_t v)
  { h[o] = v; h[o + 1] = v >> 8; };
  memcpy(h, "RIFF", 4);
  w32(4, 36 + dataBytes);
  memcpy(h + 8, "WAVE", 4);
  memcpy(h + 12, "fmt ", 4);
  w32(16, 16);
  w16(20, 1); // PCM
  w16(22, 1); // mono
  w32(24, SAMPLE_RATE);
  w32(28, byteRate);
  w16(32, 2);
  w16(34, 16); // 16-bit
  memcpy(h + 36, "data", 4);
  w32(40, dataBytes);
}

// Records while ANSWER is held. Returns audio bytes captured.
size_t recordWhileHeld()
{
  int32_t raw[256];
  size_t bytesRead = 0;
  int16_t *out = (int16_t *)(recBuf + 44);
  size_t n = 0;
  size_t maxN = recCapacity / 2;
  int32_t peak = 0;

  PLAY(SND_REC_ON); // "I'm listening" — played BEFORE the mic starts
  i2s_zero_dma_buffer(MIC_PORT);
  for (int i = 0; i < 4; i++) // drop ~60ms of startup noise
    i2s_read(MIC_PORT, raw, sizeof(raw), &bytesRead, portMAX_DELAY);

  digitalWrite(PIN_LED, LOW); // LED off = recording
  Serial.println("[MIC] Recording... (release ANSWER to stop)");

  unsigned long relSince = 0;
  while (n < maxN)
  {
    // Stop only when released steadily (ignores noise spikes)
    if (!isDown(btnAnswer))
    {
      if (!relSince)
        relSince = millis();
      else if (millis() - relSince >= RELEASE_MS)
        break;
    }
    else
      relSince = 0;

    i2s_read(MIC_PORT, raw, sizeof(raw), &bytesRead, 100 / portTICK_PERIOD_MS);
    int count = bytesRead / 4;
    for (int i = 0; i < count && n < maxN; i++)
    {
      int32_t v = raw[i] >> MIC_SHIFT;
      if (v > 32767)
        v = 32767;
      if (v < -32768)
        v = -32768;
      out[n++] = (int16_t)v;
      if (abs(v) > peak)
        peak = abs(v);
    }
  }
  waitForRelease(btnAnswer); // buffer full: wait for release
  PLAY(SND_REC_OFF);         // "got it, checking.."
  digitalWrite(PIN_LED, chunkLen > 0 ? HIGH : LOW);

  Serial.printf("[MIC] Captured %u ms, peak level %d/32767%s\n",
                (unsigned)(n * 1000 / SAMPLE_RATE), peak,
                peak < 500 ? "  <-- very quiet! check wiring / MIC_CHANNEL" : "");
  return n * 2;
}

void uploadAnswer(size_t dataBytes)
{
  writeWavHeader(recBuf, dataBytes);

  // Free the realtime connection's memory for this upload.
  // It reconnects by itself ~1s later (see setReconnectInterval).
  rtPaused = true;
  wsClient.disconnect();
  delay(50);
  Serial.printf("[MEM] free %u, largest block %u\n",
                (unsigned)ESP.getFreeHeap(), (unsigned)ESP.getMaxAllocHeap());

  WiFiClientSecure client;
  client.setInsecure();
  HTTPClient http;
  http.setTimeout(20000);

  String url = String("https://") + SUPABASE_HOST +
               "/functions/v1/grade-answer?device=" + deviceId;
  if (!http.begin(client, url))
  {
    Serial.println("[ANS] Could not start upload");
    PLAY(SND_ERROR);
    return;
  }
  http.addHeader("Authorization", String("Bearer ") + SUPABASE_KEY);
  http.addHeader("apikey", SUPABASE_KEY);
  http.addHeader("Content-Type", "audio/wav");

  Serial.printf("[ANS] Uploading %u bytes...\n", (unsigned)(dataBytes + 44));
  int code = http.POST(recBuf, dataBytes + 44);
  String resp = http.getString();
  http.end();

  Serial.printf("[ANS] HTTP %d: %s\n", code, resp.c_str());

  JsonDocument doc;
  if (code == 200 && !deserializeJson(doc, resp))
  {
    const char *result = doc["result"] | "?";
    const char *heard = doc["transcript"] | "";
    Serial.printf("[ANS] >>> %s  (heard: \"%s\")\n", result, heard);

    if (strcmp(result, "correct") == 0)
      PLAY(SND_CORRECT);
    else if (strcmp(result, "wrong") == 0)
      PLAY(SND_WRONG);
    else if (strcmp(result, "review") == 0)
      PLAY(SND_REVIEW);
    else
      PLAY(SND_ERROR); // e.g. "no_word"
  }
  else
  {
    PLAY(SND_ERROR); // upload / network / server problem
  }
}

void handleAnswerButton()
{
  if (!recBuf)
  {
    Serial.println("[ANS] Mic not available");
    PLAY(SND_ERROR);
  }
  else if (chunkLen == 0)
  {
    Serial.println("[ANS] No word on the display — nothing to answer");
    PLAY(SND_ERROR);
  }
  else
  {
    unsigned long t0 = millis();
    size_t bytes = recordWhileHeld();
    if (millis() - t0 < MIN_REC_MS || bytes < (size_t)SAMPLE_RATE * 2 * MIN_REC_MS / 1000)
    {
      Serial.println("[ANS] Too short — hold ANSWER while speaking");
      PLAY(SND_ERROR);
    }
    else
    {
      uploadAnswer(bytes);
    }
  }
  waitForRelease(btnAnswer);
  btnAnswer.stable = btnAnswer.raw = RELEASED_LVL(btnAnswer); // re-arm cleanly
}

// ═════════════════════════════════════════════════════════════
// SETUP
// ═════════════════════════════════════════════════════════════

void setup()
{
  Serial.begin(115200);
  delay(500);
  Serial.println("\n=== BRAILLE D.O.T.S. v6.11 (voice + sound) — Supabase Realtime ===");

  pinMode(PIN_DATA, OUTPUT);
  pinMode(PIN_CLOCK, OUTPUT);
  pinMode(PIN_LATCH, OUTPUT);
  pinMode(PIN_OE, OUTPUT);
  pinMode(PIN_LED, OUTPUT);
  buttonInit(btnNext);
  buttonInit(btnBack);
  buttonInit(btnAnswer);

  allCoilsOff();
  delay(200);

  micInit(); // before WiFi, while RAM is still in one big piece
  spkInit();

#if SPK_TEST_ON_BOOT
  // Loud, long, steady tone so it's easy to hear and to measure
  Serial.println("[SPK] TEST: 1 kHz tone for 2 seconds...");
  {
    const Note test[] = {{1000, 2000, SINE, false}};
    playMelody(test, 1);
  }
  Serial.println("[SPK] TEST: done");
#endif

  // ── WiFi ───────────────────────────────────────────────────
  Serial.printf("\n[WiFi] Connecting to '%s'", WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.setTxPower(WIFI_POWER_8_5dBm); // smaller current spikes → fewer brownouts
  WiFi.begin(WIFI_SSID, WIFI_PASS);

  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED && attempts < 30)
  {
    delay(500);
    Serial.print(".");
    attempts++;
  }

  if (WiFi.status() == WL_CONNECTED)
  {
    Serial.printf("\n[WiFi] Connected! IP: %s\n", WiFi.localIP().toString().c_str());
  }
  else
  {
    Serial.println("\n[WiFi] FAILED. Check SSID/password, then restart.");
    while (true)
      delay(1000);
  }

  // ── Register device (get UUID, set status = connected) ─────
  Serial.printf("\n[DEV] Pairing code: %s\n", DEVICE_CODE);
  while (!registerDevice())
  {
    Serial.println("[REG] Failed — retrying in 5s (check RLS policies)");
    delay(5000);
  }
  Serial.printf("[DEV] Registered. UUID: %s\n", deviceId);

  // ── Supabase Realtime ──────────────────────────────────────
  wsClient.beginSSL(SUPABASE_HOST, REALTIME_PORT, REALTIME_PATH);
  wsClient.onEvent(onWsEvent);
  wsClient.setExtraHeaders(
      ("apikey: " + String(SUPABASE_KEY) + "\r\n"
                                           "Authorization: Bearer " +
       String(SUPABASE_KEY))
          .c_str());
  wsClient.setReconnectInterval(1000); // quick return after an answer upload

  Serial.printf("[DEV] Pair in app with code: %s\n", DEVICE_CODE);
  Serial.printf("[PIN] At boot: NEXT=%s BACK=%s ANSWER=%s (should all be released)\n",
                isDown(btnNext) ? "PRESSED" : "released",
                isDown(btnBack) ? "PRESSED" : "released",
                isDown(btnAnswer) ? "PRESSED" : "released");
  Serial.println("[CMD] Waiting for commands...\n");
}

// ═════════════════════════════════════════════════════════════
// LOOP
// ═════════════════════════════════════════════════════════════

void loop()
{
  wsClient.loop();
  unsigned long now = millis();

  // ── Heartbeat ─────────────────────────────────────────────
  if (wsConnected && now - lastHeartbeat >= HEARTBEAT_MS)
  {
    sendHeartbeat();
    lastHeartbeat = now;
  }

  // ── Buttons (debounced, one action per press) ─────────────
  // Whole chunk is on the cells, so NEXT/BACK ask the app for the
  // next/previous chunk instead of stepping letters.
  if (buttonPressed(btnNext))
  {
    Serial.println("[BTN] NEXT");
    publishEvent("chunk_end", 0, chunkLen);
  }
  if (buttonPressed(btnBack))
  {
    Serial.println("[BTN] BACK");
    publishEvent("chunk_start", 0, chunkLen);
  }
  if (buttonPressed(btnAnswer))
  {
    Serial.println("[BTN] ANSWER");
    handleAnswerButton();
  }

  // ── Punch → hold ──────────────────────────────────────────
  if (devState == PUNCHING && now - stateTimer >= PUNCH_MS)
  {
    oeHoldPower();
    devState = HOLDING;
  }

  // ── Firmware kill-switch (backup for app crash) ───────────
  if (energized && now - energizedAt >= SAFETY_MS)
  {
    Serial.println("[SAFETY] 60s firmware timeout");
    clearDisplay();
  }
}