/*
 * ================================================================
 * BRAILLE D.O.T.S. — FIRMWARE v5 (Access Point Mode)
 * File: src/main.cpp
 *
 * ESP32 creates its OWN hotspot — no router needed.
 * Phone connects directly to ESP32.
 * IP is ALWAYS 192.168.4.1 — hardcode this in your app.
 *
 * Hotspot: "BrailleDOTS"
 * Password: "braille123"
 * WebSocket: ws://192.168.4.1:81
 *
 * ⚠  UNPLUG GPIO5 (PIN_LATCH) before every upload!
 * ================================================================
 */

#include <Arduino.h>
#include <WiFi.h>
#include <WebSocketsServer.h>
#include <ArduinoJson.h>

// ── Hotspot credentials ───────────────────────────────────────
#define AP_SSID  "BrailleDOTS"
#define AP_PASS  "braille123"
// IP is always 192.168.4.1 — hardcode this in your Android app

// ── Shift register pins ───────────────────────────────────────
#define PIN_DATA   23
#define PIN_CLOCK  18
#define PIN_LATCH   5   // ⚠ UNPLUG BEFORE UPLOAD
#define PIN_OE      4
#define PIN_LED     2

// ── Button pins ───────────────────────────────────────────────
#define BTN_NEXT    14
#define BTN_BACK    12
#define BTN_ANSWER  13

// ── Timing ───────────────────────────────────────────────────
#define DEBOUNCE_MS  200
#define PUNCH_MS     100

#define OE_FULL  0
#define OE_HOLD  140
#define OE_OFF   255

// ── Braille patterns ─────────────────────────────────────────
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

// ── WebSocket ─────────────────────────────────────────────────
WebSocketsServer ws(81);
int wsClient = -1;

// ── State machine ─────────────────────────────────────────────
enum State { PUNCHING, HOLDING };
State         devState   = HOLDING;
unsigned long stateTimer = 0;

// ── Word buffer ───────────────────────────────────────────────
char wordBuf[32] = "";
int  wordLen     = 0;
int  letterPos   = 0;

// ── Button debounce ───────────────────────────────────────────
unsigned long lastBtn = 0;


// ═════════════════════════════════════════════════════════════
// HARDWARE
// ═════════════════════════════════════════════════════════════

void oeFullPower() { analogWrite(PIN_OE, OE_FULL); }
void oeHoldPower() { analogWrite(PIN_OE, OE_HOLD); }
void oeOff()       { analogWrite(PIN_OE, OE_OFF);  }

void shift595(uint8_t pattern) {
  digitalWrite(PIN_LATCH, LOW);
  shiftOut(PIN_DATA, PIN_CLOCK, MSBFIRST, (~pattern) & 0x3F);
  digitalWrite(PIN_LATCH, HIGH);
}

void clearDisplay() {
  shift595(0x00);
  oeFullPower();
  digitalWrite(PIN_LED, LOW);
}

void showLetter(uint8_t idx) {
  if (idx > 25) return;
  uint8_t pat = BRAILLE[idx];

  Serial.printf("\n[SHOW] '%c'  dots raised: ", 'A' + idx);
  for (int d = 1; d <= 6; d++)
    if (pat & (1 << (d-1))) Serial.printf("%d ", d);
  Serial.println();

  // Staggered firing — adds solenoids one at a time with 8ms gap.
  // Prevents all solenoids hitting the 5V rail at the same moment,
  // which would cause a current spike and make some solenoids too weak.
  // For letter A: SOL2-6 fire (inverted logic), added one by one.
  shift595(0x00);   // clear first
  oeFullPower();
  delay(10);

  uint8_t invPat = (~pat) & 0x3F;   // solenoids that need to be ON
  uint8_t building = 0x00;
  for (int d = 0; d < 6; d++) {
    if (invPat & (1 << d)) {
      building |= (1 << d);
      // Send directly (already inverted) — bypass shift595 inversion
      digitalWrite(PIN_LATCH, LOW);
      shiftOut(PIN_DATA, PIN_CLOCK, MSBFIRST, building);
      digitalWrite(PIN_LATCH, HIGH);
      delay(8);
    }
  }

  digitalWrite(PIN_LED, HIGH);
  devState   = PUNCHING;
  stateTimer = millis();
}

void goTo(int pos) {
  if (wordLen == 0) {
    Serial.println("[NAV] No word loaded yet");
    return;
  }
  pos = constrain(pos, 0, wordLen - 1);
  letterPos = pos;
  showLetter(wordBuf[pos] - 'A');
}


// ═════════════════════════════════════════════════════════════
// WEBSOCKET
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

void onWsEvent(uint8_t num, WStype_t type, uint8_t* payload, size_t len) {
  switch (type) {

    case WStype_CONNECTED: {
      wsClient = num;
      IPAddress ip = ws.remoteIP(num);
      Serial.printf("\n[WS] App connected! #%d — %s\n", num, ip.toString().c_str());
      wsSend("{\"type\":\"ready\"}");
      break;
    }

    case WStype_DISCONNECTED:
      Serial.printf("[WS] Disconnected. #%d\n", num);
      if (wsClient == num) wsClient = -1;
      break;

    case WStype_TEXT: {
      Serial.printf("← App: %s\n", (char*)payload);
      JsonDocument doc;
      if (deserializeJson(doc, payload, len)) { Serial.println("[ERR] Bad JSON"); break; }
      const char* t = doc["type"];
      if (!t) break;

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
        Serial.printf("[WORD] '%s' (%d letters)\n", wordBuf, wordLen);
        if (wordLen > 0) goTo(0);
      }
      else if (strcmp(t, "display") == 0) {
        const char* ls = doc["letter"];
        if (!ls || !ls[0]) break;
        char c = toupper((unsigned char)ls[0]);
        if (c < 'A' || c > 'Z') break;
        wordBuf[0] = c; wordBuf[1] = '\0';
        wordLen = 1; letterPos = 0;
        goTo(0);
      }
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
// DIAGNOSTIC
// ═════════════════════════════════════════════════════════════
void runDiagnostic() {
  Serial.println("\n[DIAG] Firing dots 1-6 one at a time...");
  oeFullPower();
  for (int dot = 1; dot <= 6; dot++) {
    Serial.printf("[DIAG] Dot %d\n", dot);
    shift595(1 << (dot - 1));
    delay(800);
    shift595(0x00);
    delay(250);
  }
  oeOff();
  Serial.println("[DIAG] Done.\n");
  delay(300);
}


// ═════════════════════════════════════════════════════════════
// SETUP
// ═════════════════════════════════════════════════════════════
void setup() {
  Serial.begin(115200);
  delay(500);
  Serial.println("\n╔══════════════════════════════╗");
  Serial.println("║  BRAILLE D.O.T.S.   v5       ║");
  Serial.println("║  Access Point Mode            ║");
  Serial.println("╚══════════════════════════════╝");

  pinMode(PIN_DATA,   OUTPUT);
  pinMode(PIN_CLOCK,  OUTPUT);
  pinMode(PIN_LATCH,  OUTPUT);
  pinMode(PIN_OE,     OUTPUT);
  pinMode(PIN_LED,    OUTPUT);
  pinMode(BTN_NEXT,   INPUT_PULLUP);
  pinMode(BTN_BACK,   INPUT_PULLUP);
  pinMode(BTN_ANSWER, INPUT_PULLUP);

  oeOff();
  shift595(0x00);
  delay(200);

  // Comment out after wiring is verified:
  runDiagnostic();

  // Create ESP32 hotspot
  WiFi.mode(WIFI_AP);
  WiFi.softAP(AP_SSID, AP_PASS);
  WiFi.setTxPower(WIFI_POWER_8_5dBm); // Reduce WiFi power draw — frees ~200mA back to solenoids

  Serial.println("[WiFi] Hotspot created!");
  Serial.printf("[WiFi] SSID:     %s\n", AP_SSID);
  Serial.printf("[WiFi] Password: %s\n", AP_PASS);
  Serial.printf("[WiFi] IP:       %s  ← ALWAYS this, hardcode in app\n",
                WiFi.softAPIP().toString().c_str());
  Serial.println("[WiFi] Connect your phone to BrailleDOTS then open app\n");

  ws.begin();
  ws.onEvent(onWsEvent);

  Serial.println("[WS]  WebSocket ready on port 81");
  Serial.println("[BTN] NEXT=GPIO14  BACK=GPIO12  ANSWER=GPIO13");
  Serial.println("[CMD] {\"type\":\"word\",\"word\":\"HELLO\"}");
  Serial.println();
}


// ═════════════════════════════════════════════════════════════
// LOOP
// ═════════════════════════════════════════════════════════════
void loop() {
  ws.loop();
  unsigned long now = millis();

  if (now - lastBtn >= DEBOUNCE_MS) {

    if (digitalRead(BTN_NEXT) == LOW) {
      lastBtn = now;
      Serial.print("[BTN] NEXT — ");
      if (wordLen == 0) {
        Serial.println("no word loaded");
      } else if (letterPos >= wordLen - 1) {
        Serial.println("already at last letter");
      } else {
        goTo(letterPos + 1);
        sendStatus();
        Serial.printf("showing '%c' (%d/%d)\n", wordBuf[letterPos], letterPos+1, wordLen);
      }
      wsSend("{\"type\":\"button\",\"button\":\"next\"}");
    }

    else if (digitalRead(BTN_BACK) == LOW) {
      lastBtn = now;
      Serial.print("[BTN] BACK — ");
      if (wordLen == 0) {
        Serial.println("no word loaded");
      } else if (letterPos <= 0) {
        Serial.println("already at first letter");
      } else {
        goTo(letterPos - 1);
        sendStatus();
        Serial.printf("showing '%c' (%d/%d)\n", wordBuf[letterPos], letterPos+1, wordLen);
      }
      wsSend("{\"type\":\"button\",\"button\":\"back\"}");
    }

    else if (digitalRead(BTN_ANSWER) == LOW) {
      lastBtn = now;
      Serial.println("[BTN] ANSWER");
      wsSend("{\"type\":\"button\",\"button\":\"answer\"}");
    }
  }

  switch (devState) {
    case PUNCHING:
      if (now - stateTimer >= PUNCH_MS) {
        oeHoldPower();
        devState = HOLDING;
      }
      break;
    case HOLDING:
      break;
  }
}