/*
 * ================================================================
 * BRAILLE D.O.T.S. — FIRMWARE v6 (Supabase Realtime Mode)
 * File: src/main.cpp
 *
 * ESP32 connects to a WiFi router and communicates with the
 * mobile app via Supabase Realtime (cloud WebSocket).
 *
 * No direct phone-to-device connection needed.
 * Commands arrive through: device_commands table (Realtime)
 * Button events sent to:   device_events  table (Realtime)
 *
 * ── Fill in before flashing ───────────────────────────────────
 *   WIFI_SSID      Your router SSID
 *   WIFI_PASS      Your router password
 *   SUPABASE_URL   https://nacknvkbcjxuthtycdzj.supabase.co
 *   SUPABASE_KEY   eyJhbGci... (anon key)
 *   DEVICE_ID      9a087f81-6b1e-45fb-aea6-7985fa8e21ba
 *
 * ── Payload format (device_commands) ─────────────────────────
 *   { "device_id": "<uuid>", "chunk": "HELLO" }
 *   chunk = up to 5 uppercase letters (one braille cell each)
 *
 * ⚠  UNPLUG GPIO5 (PIN_LATCH) before every upload!
 * ================================================================
 */

#include <Arduino.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <WebSocketsClient.h>
#include <ArduinoJson.h>

// ── WiFi credentials (fill in) ────────────────────────────────
#define WIFI_SSID   "YOUR_WIFI_SSID"
#define WIFI_PASS   "YOUR_WIFI_PASSWORD"

// ── Supabase config ───────────────────────────────────────────
#define SUPABASE_HOST   "nacknvkbcjxuthtycdzj.supabase.co"
#define SUPABASE_KEY    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5hY2tudmtiY2p4dXRodHljZHpqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkxMTU3NjcsImV4cCI6MjA5NDY5MTc2N30.tFeY8qDCWA43dYHVv72OPfDcp3dSzNB06mSYc1Hgx9I"
#define DEVICE_ID       "9a087f81-6b1e-45fb-aea6-7985fa8e21ba"

// Supabase Realtime WebSocket endpoint
// wss://<host>/realtime/v1/websocket?apikey=<key>&vsn=1.0.0
#define REALTIME_PATH   "/realtime/v1/websocket?apikey=" SUPABASE_KEY "&vsn=1.0.0"
#define REALTIME_PORT   443

// Channels
#define CHAN_COMMANDS    "realtime:public:device_commands"
#define CHAN_EVENTS      "realtime:public:device_events"

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
#define DEBOUNCE_MS      200
#define PUNCH_MS         100
#define HEARTBEAT_MS   25000   // Supabase heartbeat every 25s

#define OE_FULL  0
#define OE_HOLD  140
#define OE_OFF   255

// ── Braille patterns ──────────────────────────────────────────
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

// ── WebSocket client (secure) ─────────────────────────────────
WebSocketsClient wsClient;
bool             wsConnected  = false;
unsigned long    lastHeartbeat = 0;

// ── Realtime join ref counter ─────────────────────────────────
int joinRef = 1;   // increments per join message

// ── State machine ─────────────────────────────────────────────
enum State { PUNCHING, HOLDING };
State         devState   = HOLDING;
unsigned long stateTimer = 0;

// ── Chunk buffer ──────────────────────────────────────────────
// Holds up to 5 letters (one chunk from the app)
char chunkBuf[6] = "";   // e.g. "HELLO\0"
int  chunkLen    = 0;
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

  // Staggered firing — adds solenoids one at a time with 8ms gap
  shift595(0x00);
  oeFullPower();
  delay(10);

  uint8_t invPat  = (~pat) & 0x3F;
  uint8_t building = 0x00;
  for (int d = 0; d < 6; d++) {
    if (invPat & (1 << d)) {
      building |= (1 << d);
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
  if (chunkLen == 0) {
    Serial.println("[NAV] No chunk loaded yet");
    return;
  }
  pos       = constrain(pos, 0, chunkLen - 1);
  letterPos = pos;
  showLetter(chunkBuf[pos] - 'A');
}


// ═════════════════════════════════════════════════════════════
// SUPABASE REALTIME — SEND
// ═════════════════════════════════════════════════════════════

// Send raw JSON string over the WebSocket
void rtSend(const String& json) {
  if (wsConnected) {
    wsClient.sendTXT(json);
    Serial.printf("→ Supabase: %s\n", json.c_str());
  } else {
    Serial.println("[RT] Not connected — message dropped");
  }
}

// Subscribe to a Realtime channel
void joinChannel(const char* channel) {
  // Supabase Realtime Phoenix protocol join message
  String msg = "{\"topic\":\"" + String(channel) + "\","
               "\"event\":\"phx_join\","
               "\"payload\":{},"
               "\"ref\":\"" + String(joinRef++) + "\"}";
  rtSend(msg);
}

// Send heartbeat to keep connection alive
void sendHeartbeat() {
  String msg = "{\"topic\":\"phoenix\","
               "\"event\":\"heartbeat\","
               "\"payload\":{},"
               "\"ref\":\"hb\"}";
  rtSend(msg);
}

// Insert a row into device_events via Realtime broadcast
// (The app listens on CHAN_EVENTS and reads these)
void publishEvent(const char* eventType, int posIndex, int totalLen) {
  // We broadcast on the device_events channel using Supabase Realtime broadcast
  // Format matches what the app expects
  char payload[256];
  snprintf(payload, sizeof(payload),
    "{\"device_id\":\"%s\",\"event_type\":\"%s\","
    "\"letter_index\":%d,\"chunk_length\":%d}",
    DEVICE_ID, eventType, posIndex, totalLen);

  String msg = "{\"topic\":\"" + String(CHAN_EVENTS) + "\","
               "\"event\":\"broadcast\","
               "\"payload\":{\"type\":\"broadcast\",\"event\":\"device_event\","
               "\"payload\":" + String(payload) + "},"
               "\"ref\":\"" + String(joinRef++) + "\"}";
  rtSend(msg);
}


// ═════════════════════════════════════════════════════════════
// SUPABASE REALTIME — RECEIVE
// ═════════════════════════════════════════════════════════════

void handleCommand(JsonDocument& doc) {
  // Expected payload structure from app:
  // {
  //   "type": "broadcast",
  //   "event": "device_command",
  //   "payload": {
  //     "device_id": "<uuid>",
  //     "chunk": "HELLO"
  //   }
  // }

  const char* type = doc["payload"]["type"];
  if (!type || strcmp(type, "broadcast") != 0) return;

  const char* event = doc["payload"]["event"];
  if (!event || strcmp(event, "device_command") != 0) return;

  JsonObject innerPayload = doc["payload"]["payload"];

  // Filter: only process commands for THIS device
  const char* targetId = innerPayload["device_id"];
  if (!targetId || strcmp(targetId, DEVICE_ID) != 0) {
    Serial.println("[CMD] Ignored — not for this device");
    return;
  }

  const char* chunk = innerPayload["chunk"];
  if (!chunk || !chunk[0]) {
    Serial.println("[CMD] Missing chunk field");
    return;
  }

  // Load chunk into buffer (uppercase, letters only, max 5)
  chunkLen = 0;
  for (int i = 0; chunk[i] && chunkLen < 5; i++) {
    char c = toupper((unsigned char)chunk[i]);
    if (c >= 'A' && c <= 'Z') chunkBuf[chunkLen++] = c;
  }
  chunkBuf[chunkLen] = '\0';
  letterPos = 0;

  Serial.printf("[CMD] Chunk received: '%s' (%d letters)\n", chunkBuf, chunkLen);

  if (chunkLen > 0) goTo(0);
}

void onWsEvent(WStype_t type, uint8_t* payload, size_t length) {
  switch (type) {

    case WStype_CONNECTED:
      wsConnected = true;
      Serial.println("\n[RT] Connected to Supabase Realtime!");
      // Subscribe to both channels
      joinChannel(CHAN_COMMANDS);
      joinChannel(CHAN_EVENTS);
      lastHeartbeat = millis();
      break;

    case WStype_DISCONNECTED:
      wsConnected = false;
      Serial.println("[RT] Disconnected from Supabase Realtime. Will retry...");
      break;

    case WStype_TEXT: {
      Serial.printf("← Supabase: %s\n", (char*)payload);

      JsonDocument doc;
      DeserializationError err = deserializeJson(doc, payload, length);
      if (err) {
        Serial.printf("[ERR] JSON parse failed: %s\n", err.c_str());
        break;
      }

      const char* event = doc["event"];
      if (!event) break;

      // Ignore internal Phoenix protocol messages
      if (strcmp(event, "phx_reply") == 0 ||
          strcmp(event, "phx_close") == 0 ||
          strcmp(event, "heartbeat")  == 0) {
        Serial.printf("[RT] Protocol msg: %s\n", event);
        break;
      }

      // Handle incoming broadcast on device_commands channel
      const char* topic = doc["topic"];
      if (topic && strcmp(topic, CHAN_COMMANDS) == 0) {
        handleCommand(doc);
      }

      break;
    }

    case WStype_ERROR:
      Serial.println("[RT] WebSocket error");
      break;

    case WStype_PING:
      Serial.println("[RT] Ping received");
      break;

    case WStype_PONG:
      Serial.println("[RT] Pong received");
      break;

    default:
      break;
  }
}


// ═════════════════════════════════════════════════════════════
// SETUP
// ═════════════════════════════════════════════════════════════

void setup() {
  Serial.begin(115200);
  delay(500);
  Serial.println("\n╔══════════════════════════════╗");
  Serial.println("║  BRAILLE D.O.T.S.   v6       ║");
  Serial.println("║  Supabase Realtime Mode       ║");
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

  // ── Connect to WiFi ────────────────────────────────────────
  Serial.printf("\n[WiFi] Connecting to '%s'", WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);

  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED && attempts < 30) {
    delay(500);
    Serial.print(".");
    attempts++;
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("\n[WiFi] Connected!");
    Serial.printf("[WiFi] IP: %s\n", WiFi.localIP().toString().c_str());
  } else {
    Serial.println("\n[WiFi] FAILED to connect. Check SSID/password.");
    Serial.println("[WiFi] Halting — restart device after fixing credentials.");
    while (true) delay(1000);
  }

  // ── Connect to Supabase Realtime ───────────────────────────
  Serial.println("\n[RT] Connecting to Supabase Realtime...");
  Serial.printf("[RT] Host: %s\n", SUPABASE_HOST);
  Serial.printf("[RT] Path: %s\n", REALTIME_PATH);

  // Use secure WebSocket (wss://) on port 443
  wsClient.beginSSL(SUPABASE_HOST, REALTIME_PORT, REALTIME_PATH);
  wsClient.onEvent(onWsEvent);

  // Add required headers for Supabase authentication
  wsClient.setExtraHeaders(
    ("apikey: " + String(SUPABASE_KEY) + "\r\n"
     "Authorization: Bearer " + String(SUPABASE_KEY)).c_str()
  );

  // Reconnect automatically if dropped
  wsClient.setReconnectInterval(5000);

  Serial.println("[RT] WebSocket client started — waiting for connection...");
  Serial.printf("[DEV] Device ID: %s\n", DEVICE_ID);
  Serial.println("\n[BTN] NEXT=GPIO14  BACK=GPIO12  ANSWER=GPIO13");
  Serial.println("[CMD] Waiting for chunk via Supabase Realtime...\n");
}


// ═════════════════════════════════════════════════════════════
// LOOP
// ═════════════════════════════════════════════════════════════

void loop() {
  wsClient.loop();
  unsigned long now = millis();

  // ── Heartbeat ─────────────────────────────────────────────
  if (wsConnected && now - lastHeartbeat >= HEARTBEAT_MS) {
    sendHeartbeat();
    lastHeartbeat = now;
  }

  // ── Buttons ───────────────────────────────────────────────
  if (now - lastBtn >= DEBOUNCE_MS) {

    if (digitalRead(BTN_NEXT) == LOW) {
      lastBtn = now;
      Serial.printf("[DEBUG] chunkLen=%d letterPos=%d\n", chunkLen, letterPos);
      Serial.print("[BTN] NEXT — ");
      if (chunkLen == 0) {
        Serial.println("no chunk loaded");
      } else if (letterPos >= chunkLen - 1) {
        Serial.println("already at last letter");
        // Notify app: student reached end of chunk — request next chunk
        publishEvent("chunk_end", letterPos, chunkLen);
      } else {
        goTo(letterPos + 1);
        publishEvent("next", letterPos, chunkLen);
        Serial.printf("showing '%c' (%d/%d)\n", chunkBuf[letterPos], letterPos+1, chunkLen);
      }
    }

    else if (digitalRead(BTN_BACK) == LOW) {
      lastBtn = now;
      Serial.print("[BTN] BACK — ");
      if (chunkLen == 0) {
        Serial.println("no chunk loaded");
      } else if (letterPos <= 0) {
        Serial.println("already at first letter");
        // Notify app: student went back past chunk start — request prev chunk
        publishEvent("chunk_start", letterPos, chunkLen);
      } else {
        goTo(letterPos - 1);
        publishEvent("back", letterPos, chunkLen);
        Serial.printf("showing '%c' (%d/%d)\n", chunkBuf[letterPos], letterPos+1, chunkLen);
      }
    }

    else if (digitalRead(BTN_ANSWER) == LOW) {
      lastBtn = now;
      Serial.println("[BTN] ANSWER");
      publishEvent("answer", letterPos, chunkLen);
    }
  }

  // ── State machine (solenoid punch → hold) ─────────────────
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