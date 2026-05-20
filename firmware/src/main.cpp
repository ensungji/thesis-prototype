/*
 * ================================================================
 * BRAILLE D.O.T.S. — FIRMWARE v2 (PlatformIO)
 * File: src/main.cpp
 *
 * FIXES FROM v1:
 *   1. Buttons navigate letters LOCALLY — no app round-trip needed.
 *   2. (& 0x3F) mask — bits 6-7 never accidentally fire solenoids.
 *   3. Solenoid diagnostic on boot — fires dots 1-6 one at a time.
 *   4. Accepts {"type":"word","word":"HELLO"} to load a full word.
 *   5. Better Serial output for debugging.
 *
 * PROJECT STRUCTURE (PlatformIO):
 *   your_project/
 *   ├── platformio.ini      ← board config + library deps
 *   └── src/
 *       └── main.cpp        ← this file
 *
 * HOW TO BUILD:
 *   VSCode: click the checkmark (✓) in the bottom toolbar to build.
 *   Upload: click the arrow (→) to build + flash.
 *   Monitor: click the plug icon to open serial monitor.
 *   Or use the PlatformIO sidebar panel.
 *
 * ⚠  GPIO5 (PIN_LATCH) must be UNPLUGGED before every upload!
 * ================================================================
 */

#include <Arduino.h>
#include <WiFi.h>
#include <WebSocketsServer.h>
#include <ArduinoJson.h>

// ── WiFi ─────────────────────────────────────────────────────
#define WIFI_SSID  "N!EZFERNANDEZ 4G"
#define WIFI_PASS  "FernandezNiez2003"

// ── Shift register pins ───────────────────────────────────────
#define PIN_DATA   23   // 74HC595 DS   (Pin 14)
#define PIN_CLOCK  18   // 74HC595 SHCP (Pin 11)
#define PIN_LATCH   5   // 74HC595 STCP (Pin 12) ⚠ UNPLUG BEFORE UPLOAD
#define PIN_OE      4   // 74HC595 OE   (Pin 13) — Active LOW
#define PIN_LED     2   // Onboard LED (built-in on most ESP32 boards)

// ── Button pins (INPUT_PULLUP — LOW when pressed) ─────────────
#define BTN_NEXT    14
#define BTN_BACK    12
#define BTN_ANSWER  13

// ── Timing ───────────────────────────────────────────────────
#define DEBOUNCE_MS    200   // Ignore presses within this window (ms)
#define PUNCH_MS       100   // Full-power time before reducing to hold (ms)
#define TRANSITION_MS  300   // Gap between letters — all dots retract (ms)

// OE PWM duty values for analogWrite (0–255)
// PIN_OE is ACTIVE LOW on the 74HC595:
//   0   = always LOW  = outputs always enabled  (full power)
//   140 = ~45% on     = outputs partially on    (hold power, less heat)
//   255 = always HIGH = outputs disabled        (all solenoids off)
#define OE_FULL_POWER  0
#define OE_HOLD_POWER  140
#define OE_DISABLED    255

// ── Braille cell layout ───────────────────────────────────────
//
//   Physical cell:      Firmware bit:    Q pin → SOL:
//    [Dot1] [Dot4]       bit0   bit3      Q0 → SOL1 (top-left)
//    [Dot2] [Dot5]       bit1   bit4      Q1 → SOL2 (mid-left)
//    [Dot3] [Dot6]       bit2   bit5      Q2 → SOL3 (bot-left)
//                                         Q3 → SOL4 (top-right)
//                                         Q4 → SOL5 (mid-right)
//                                         Q5 → SOL6 (bot-right)
//
//  SOLENOIDS ARE INVERTED (spring holds dot UP by default):
//   Braille bit = 1  → dot RAISED   → solenoid OFF → Q pin LOW
//   Braille bit = 0  → dot retracted → solenoid ON  → Q pin HIGH
//   Solution: send (~pattern) & 0x3F to the shift register.

#define DOT1 (1 << 0)
#define DOT2 (1 << 1)
#define DOT3 (1 << 2)
#define DOT4 (1 << 3)
#define DOT5 (1 << 4)
#define DOT6 (1 << 5)

const uint8_t BRAILLE[26] = {
  /* A */ DOT1,
  /* B */ DOT1|DOT2,
  /* C */ DOT1|DOT4,
  /* D */ DOT1|DOT4|DOT5,
  /* E */ DOT1|DOT5,
  /* F */ DOT1|DOT2|DOT4,
  /* G */ DOT1|DOT2|DOT4|DOT5,
  /* H */ DOT1|DOT2|DOT5,
  /* I */ DOT2|DOT4,
  /* J */ DOT2|DOT4|DOT5,
  /* K */ DOT1|DOT3,
  /* L */ DOT1|DOT2|DOT3,
  /* M */ DOT1|DOT3|DOT4,
  /* N */ DOT1|DOT3|DOT4|DOT5,
  /* O */ DOT1|DOT3|DOT5,
  /* P */ DOT1|DOT2|DOT3|DOT4,
  /* Q */ DOT1|DOT2|DOT3|DOT4|DOT5,
  /* R */ DOT1|DOT2|DOT3|DOT5,
  /* S */ DOT2|DOT3|DOT4,
  /* T */ DOT2|DOT3|DOT4|DOT5,
  /* U */ DOT1|DOT3|DOT6,
  /* V */ DOT1|DOT2|DOT3|DOT6,
  /* W */ DOT2|DOT4|DOT5|DOT6,
  /* X */ DOT1|DOT3|DOT4|DOT6,
  /* Y */ DOT1|DOT3|DOT4|DOT5|DOT6,
  /* Z */ DOT1|DOT3|DOT5|DOT6,
};

// ── WebSocket server on port 81 ───────────────────────────────
WebSocketsServer ws(81);
int wsClient = -1;

// ── State machine ─────────────────────────────────────────────
enum State { PUNCHING, HOLDING, TRANSITIONING };
State         devState   = HOLDING;
unsigned long stateTimer = 0;
uint8_t       pendingIdx = 255;   // 255 = nothing pending

// ── Word buffer ───────────────────────────────────────────────
// Stores the current word so buttons can navigate locally
// without waiting for the Android app to respond.
char wordBuf[32] = "";
int  wordLen     = 0;
int  letterPos   = 0;

// ── Button debounce ───────────────────────────────────────────
unsigned long lastBtn = 0;


// ═════════════════════════════════════════════════════════════
// LOW-LEVEL HARDWARE
// ═════════════════════════════════════════════════════════════

void oeFullPower() { analogWrite(PIN_OE, OE_FULL_POWER); }
void oeHoldPower() { analogWrite(PIN_OE, OE_HOLD_POWER); }
void oeOff()       { analogWrite(PIN_OE, OE_DISABLED);   }

// Send a Braille dot pattern to the 74HC595 shift register.
//
// (~pattern) & 0x3F  — what this does:
//   ~pattern  flips all 8 bits. A raised dot (bit=1) becomes 0 so the Q pin
//             goes LOW → ULN2803 inactive → solenoid OFF → spring pushes dot UP.
//             A retracted dot (bit=0) becomes 1 so Q HIGH → ULN sinks →
//             solenoid ON → dot pulled DOWN.
//   & 0x3F   masks the top 2 bits (bits 6 and 7) to zero so Q6 and Q7
//            NEVER fire, even if a letter pattern leaves those bits set.
//            This was the bug causing the wrong solenoid to activate in v1.
void shift595(uint8_t pattern) {
  digitalWrite(PIN_LATCH, LOW);
  shiftOut(PIN_DATA, PIN_CLOCK, MSBFIRST, (~pattern) & 0x3F);
  digitalWrite(PIN_LATCH, HIGH);
}


// ═════════════════════════════════════════════════════════════
// HIGH-LEVEL DISPLAY
// ═════════════════════════════════════════════════════════════

// Retract all dots — used as the blank gap between letters.
void clearDisplay() {
  shift595(0x00);   // ~0x00 = 0xFF → masked to 0x3F → all Q0-Q5 HIGH → all 6 solenoids ON → dots DOWN
  oeFullPower();
  digitalWrite(PIN_LED, LOW);
}

// Show a letter by A-Z index (0=A … 25=Z) with full debug output.
void showLetter(uint8_t idx) {
  if (idx > 25) return;
  uint8_t pat = BRAILLE[idx];

  // Print exactly which dots fire — read this on Serial Monitor
  // to verify the correct physical solenoids are activating.
  Serial.printf("\n[SHOW] '%c'  raw=0x%02X  bits(5→0): ", 'A' + idx, pat);
  for (int b = 5; b >= 0; b--) Serial.print((pat >> b) & 1);
  Serial.print("  raised dots: ");
  for (int d = 1; d <= 6; d++)
    if (pat & (1 << (d-1))) Serial.printf("%d ", d);
  Serial.println();

  shift595(pat);
  oeFullPower();
  digitalWrite(PIN_LED, HIGH);
  devState   = PUNCHING;
  stateTimer = millis();
}

// Queue a move to position `pos` in the word buffer.
// Inserts a TRANSITION_MS gap (all dots retract) before showing the new letter.
void goTo(int pos) {
  if (wordLen == 0) {
    Serial.println("[NAV] No word loaded. Send {\"type\":\"word\",\"word\":\"HELLO\"} from app.");
    return;
  }
  pos        = constrain(pos, 0, wordLen - 1);
  letterPos  = pos;
  uint8_t idx = (uint8_t)(wordBuf[pos] - 'A');

  if (devState == TRANSITIONING) {
    // Already in the gap between letters — just update which letter comes next.
    pendingIdx = idx;
    stateTimer = millis();  // reset timer so the new letter gets a full gap
  } else {
    clearDisplay();
    devState   = TRANSITIONING;
    stateTimer = millis();
    pendingIdx = idx;
  }
}


// ═════════════════════════════════════════════════════════════
// WEBSOCKET HELPERS
// ═════════════════════════════════════════════════════════════

void wsSend(const char* json) {
  if (wsClient >= 0) {
    ws.sendTXT(wsClient, json);
    Serial.printf("→ App: %s\n", json);
  }
}

void sendStatus() {
  char buf[128];
  char ltr = (wordLen > 0 && letterPos < wordLen) ? wordBuf[letterPos] : '?';
  snprintf(buf, sizeof(buf),
    "{\"type\":\"status\",\"letter\":\"%c\",\"index\":%d,\"total\":%d,\"word\":\"%s\"}",
    ltr, letterPos, wordLen, wordBuf);
  wsSend(buf);
}


// ═════════════════════════════════════════════════════════════
// SOLENOID DIAGNOSTIC
// Fires each solenoid one at a time for 800ms on every boot.
// Watch / feel which physical dot raises for each number.
//
// Expected layout if wired correctly:
//   Test 1 → top-left  (Dot 1)
//   Test 2 → mid-left  (Dot 2)
//   Test 3 → bot-left  (Dot 3)
//   Test 4 → top-right (Dot 4)
//   Test 5 → mid-right (Dot 5)
//   Test 6 → bot-right (Dot 6)
//
// If the physical dot that raises doesn't match the test number,
// your solenoids are wired in a different order. Note which physical
// dot fires for each test number and reply — we'll add a remap table.
//
// Comment out runDiagnostic() in setup() once wiring is verified.
// ═════════════════════════════════════════════════════════════
void runDiagnostic() {
  Serial.println();
  Serial.println("╔══════════════════════════════════════════╗");
  Serial.println("║       SOLENOID WIRING DIAGNOSTIC         ║");
  Serial.println("╠══════════════════════════════════════════╣");
  Serial.println("║  Firing dots 1-6 one at a time, 800ms.   ║");
  Serial.println("║  Feel which physical dot raises each time.║");
  Serial.println("║  Expected: 1=top-left … 6=bot-right      ║");
  Serial.println("╚══════════════════════════════════════════╝");
  Serial.println();

  oeFullPower();
  for (int dot = 1; dot <= 6; dot++) {
    uint8_t pat = (1 << (dot - 1));
    Serial.printf("  Test %d — Q%d high → SOL%d fires → should be Dot%d\n",
                  dot, dot-1, dot, dot);
    shift595(pat);
    delay(800);
    shift595(0x00);   // retract all between tests
    oeFullPower();
    delay(250);
  }

  oeOff();
  Serial.println();
  Serial.println("  Diagnostic done.");
  Serial.println("  If a wrong dot fired, note which physical dot");
  Serial.println("  matched each test number and we'll remap in firmware.");
  Serial.println();
  delay(500);
}


// ═════════════════════════════════════════════════════════════
// WEBSOCKET EVENT HANDLER
// ═════════════════════════════════════════════════════════════
void onWsEvent(uint8_t num, WStype_t type, uint8_t* payload, size_t len) {
  switch (type) {

    case WStype_CONNECTED: {
      wsClient = num;
      IPAddress ip = ws.remoteIP(num);
      Serial.printf("\n[WS] App connected! Client #%d — %s\n",
                    num, ip.toString().c_str());
      wsSend("{\"type\":\"ready\"}");
      break;
    }

    case WStype_DISCONNECTED:
      Serial.printf("[WS] Disconnected. Client #%d\n", num);
      if (wsClient == num) wsClient = -1;
      break;

    case WStype_TEXT: {
      Serial.printf("← App: %s\n", (char*)payload);

      JsonDocument doc;
      if (deserializeJson(doc, payload, len)) {
        Serial.println("[ERR] Bad JSON — ignored");
        break;
      }
      const char* t = doc["type"];
      if (!t) break;

      // ── {"type":"word","word":"HELLO"} ──────────────────
      // Best way to send content. Device stores the whole word,
      // shows the first letter, then NEXT/BACK buttons work locally.
      if (strcmp(t, "word") == 0) {
        const char* w = doc["word"];
        if (!w) break;
        wordLen = 0;
        for (int i = 0; w[i] && wordLen < 31; i++) {
          char c = toupper((unsigned char)w[i]);
          if (c >= 'A' && c <= 'Z') wordBuf[wordLen++] = c;
        }
        wordBuf[wordLen] = '\0';
        letterPos = 0;
        Serial.printf("[WORD] Loaded: '%s' (%d letters)\n", wordBuf, wordLen);
        if (wordLen > 0) goTo(0);
      }

      // ── {"type":"display","letter":"H"} ────────────────
      // Legacy command. Still works — wraps into a 1-letter word.
      else if (strcmp(t, "display") == 0) {
        const char* ls = doc["letter"];
        if (!ls || !ls[0]) break;
        char c = toupper((unsigned char)ls[0]);
        if (c < 'A' || c > 'Z') break;
        wordBuf[0] = c; wordBuf[1] = '\0';
        wordLen = 1; letterPos = 0;
        Serial.printf("[LEGACY] Single letter: '%c'\n", c);
        goTo(0);
      }

      // ── {"type":"next"} / {"type":"back"} ─────────────
      // App can also trigger navigation if needed.
      else if (strcmp(t, "next") == 0) {
        if (letterPos < wordLen - 1) { goTo(letterPos + 1); sendStatus(); }
      }
      else if (strcmp(t, "back") == 0) {
        if (letterPos > 0) { goTo(letterPos - 1); sendStatus(); }
      }

      break;
    }

    default: break;
  }
}


// ═════════════════════════════════════════════════════════════
// SETUP
// ═════════════════════════════════════════════════════════════
void setup() {
  Serial.begin(115200);
  delay(500);

  Serial.println("\n╔══════════════════════════════╗");
  Serial.println("║  BRAILLE D.O.T.S.   v2       ║");
  Serial.println("║  PlatformIO / VSCode build    ║");
  Serial.println("╚══════════════════════════════╝");

  // Pin modes
  pinMode(PIN_DATA,   OUTPUT);
  pinMode(PIN_CLOCK,  OUTPUT);
  pinMode(PIN_LATCH,  OUTPUT);
  pinMode(PIN_OE,     OUTPUT);
  pinMode(PIN_LED,    OUTPUT);
  pinMode(BTN_NEXT,   INPUT_PULLUP);
  pinMode(BTN_BACK,   INPUT_PULLUP);
  pinMode(BTN_ANSWER, INPUT_PULLUP);

  // Disable outputs during boot so nothing fires unexpectedly
  oeOff();
  shift595(0x00);
  delay(200);

  // ── SOLENOID DIAGNOSTIC ─────────────────────────────────
  // Fires each solenoid once so you can confirm wiring order.
  // Comment out this line after wiring is verified:
  runDiagnostic();
  // ────────────────────────────────────────────────────────

  // Connect to WiFi
  Serial.printf("[WiFi] Connecting to '%s'", WIFI_SSID);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  for (int i = 0; WiFi.status() != WL_CONNECTED && i < 30; i++) {
    delay(500);
    Serial.print(".");
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("\n[WiFi] Connected!  Device IP: %s\n",
                  WiFi.localIP().toString().c_str());
    Serial.println("[WiFi] Enter this IP in your Android app  (port 81, WebSocket)\n");
  } else {
    Serial.println("\n[WiFi] FAILED — check WIFI_SSID / WIFI_PASS at top of file");
  }

  ws.begin();
  ws.onEvent(onWsEvent);

  Serial.println("[WS]   WebSocket ready on port 81");
  Serial.println("[BTN]  NEXT=GPIO14  BACK=GPIO12  ANSWER=GPIO13");
  Serial.println("[CMD]  Send word:    {\"type\":\"word\",\"word\":\"HELLO\"}");
  Serial.println("       Single letter:{\"type\":\"display\",\"letter\":\"A\"}");
  Serial.println();
}


// ═════════════════════════════════════════════════════════════
// LOOP
// ═════════════════════════════════════════════════════════════
void loop() {
  ws.loop();  // Must be called every single iteration
  unsigned long now = millis();

  // ── Physical button handling ─────────────────────────────
  // Buttons now navigate locally using the stored word buffer.
  // The app does NOT need to respond — navigation happens immediately.
  if (now - lastBtn >= DEBOUNCE_MS && devState != TRANSITIONING) {

    if (digitalRead(BTN_NEXT) == LOW) {
      lastBtn = now;
      if (wordLen == 0) {
        Serial.println("[BTN] NEXT — no word loaded yet");
      } else if (letterPos >= wordLen - 1) {
        Serial.println("[BTN] NEXT — already at last letter");
      } else {
        goTo(letterPos + 1);
        sendStatus();
        Serial.printf("[BTN] NEXT → [%d/%d] '%c'\n",
                      letterPos + 1, wordLen, wordBuf[letterPos]);
      }
      wsSend("{\"type\":\"button\",\"button\":\"next\"}");
    }

    else if (digitalRead(BTN_BACK) == LOW) {
      lastBtn = now;
      if (wordLen == 0) {
        Serial.println("[BTN] BACK — no word loaded yet");
      } else if (letterPos <= 0) {
        Serial.println("[BTN] BACK — already at first letter");
      } else {
        goTo(letterPos - 1);
        sendStatus();
        Serial.printf("[BTN] BACK → [%d/%d] '%c'\n",
                      letterPos + 1, wordLen, wordBuf[letterPos]);
      }
      wsSend("{\"type\":\"button\",\"button\":\"back\"}");
    }

    else if (digitalRead(BTN_ANSWER) == LOW) {
      lastBtn = now;
      Serial.println("[BTN] ANSWER — student is responding");
      wsSend("{\"type\":\"button\",\"button\":\"answer\"}");
    }
  }

  // ── State machine ────────────────────────────────────────
  switch (devState) {

    case PUNCHING:
      // After full-power punch phase, drop to hold power to prevent overheating
      if (now - stateTimer >= PUNCH_MS) {
        oeHoldPower();
        devState = HOLDING;
      }
      break;

    case HOLDING:
      // Dots are stable — waiting for a button press or app command
      break;

    case TRANSITIONING:
      // All dots are retracted. After the gap, show the pending letter.
      if (now - stateTimer >= TRANSITION_MS && pendingIdx < 26) {
        showLetter(pendingIdx);
        pendingIdx = 255;
        sendStatus();
      }
      break;
  }
}