/*
 * ============================================================
 * BRAILLE D.O.T.S — ESP32 FIRMWARE
 * WiFi + WebSocket + Solenoid Driver
 * ============================================================
 */

#include <Arduino.h>
#include <WiFi.h>
#include <WebSocketsServer.h>
#include <ArduinoJson.h>

// ── WiFi credentials ──────────────────────────────────────
// Change these to match the network your phone will be on
#define WIFI_SSID "Redmi Note 13"
#define WIFI_PASS "laptopyawabogo"

// ── Shift register pins ───────────────────────────────────
#define PIN_DATA   23
#define PIN_CLOCK  18
#define PIN_LATCH   5
#define PIN_OE      4   // Output Enable — PWM throttle
#define PIN_LED     2

// ── Button pins ───────────────────────────────────────────
#define BTN_NEXT    14
#define BTN_BACK    12
#define BTN_ANSWER  13

// ── Timing ────────────────────────────────────────────────
#define DEBOUNCE_MS    200
#define TRANSITION_MS  300
#define PUNCH_MS       100

// ── Braille dot bitmasks ──────────────────────────────────
#define DOT1  (1 << 0)
#define DOT2  (1 << 1)
#define DOT3  (1 << 2)
#define DOT4  (1 << 3)
#define DOT5  (1 << 4)
#define DOT6  (1 << 5)

const uint8_t brailleAlphabet[26] = {
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

// ── WebSocket server on port 81 ───────────────────────────
WebSocketsServer webSocket(81);
int connectedClient = -1;

// ── State machine (unchanged from original) ───────────────
enum State { PUNCHING, DISPLAYING, TRANSITIONING };
State currentState = DISPLAYING;

unsigned long lastButtonPress = 0;
unsigned long transitionStart = 0;
unsigned long punchStartTime  = 0;

uint8_t letterIndex   = 0;
int8_t  pendingLetter = -1;

// ── Shift register output ─────────────────────────────────
void shiftOut595(uint8_t pattern) {
  digitalWrite(PIN_LATCH, LOW);
  shiftOut(PIN_DATA, PIN_CLOCK, MSBFIRST, ~pattern); // Inverted for pull solenoids
  digitalWrite(PIN_LATCH, HIGH);
}

// ── Clear all solenoids ───────────────────────────────────
void clearDisplay() {
  analogWrite(PIN_OE, 0);
  shiftOut595(0x00);
  digitalWrite(PIN_LED, LOW);
}

// ── Display a letter by A–Z index ────────────────────────
void showLetter(uint8_t index) {
  if (index > 25) return;
  letterIndex = index;

  shiftOut595(brailleAlphabet[index]);
  digitalWrite(PIN_LED, HIGH);
  analogWrite(PIN_OE, 0); // 100% punch power

  currentState   = PUNCHING;
  punchStartTime = millis();

  Serial.printf("Displaying: %c\n", 'A' + index);
}

// ── Send JSON to the mobile app ───────────────────────────
void sendToApp(const char* json) {
  if (connectedClient >= 0) {
    webSocket.sendTXT(connectedClient, json);
    Serial.printf("→ App: %s\n", json);
  } else {
    Serial.println("(no app connected)");
  }
}

// ── WebSocket event handler ───────────────────────────────
void onWebSocketEvent(
    uint8_t clientNum,
    WStype_t type,
    uint8_t* payload,
    size_t length
) {
  switch (type) {

    case WStype_CONNECTED: {
      IPAddress ip = webSocket.remoteIP(clientNum);
      Serial.printf("\nApp connected! Client #%d — %s\n",
                    clientNum, ip.toString().c_str());
      connectedClient = clientNum;
      sendToApp("{\"type\":\"ready\"}");
      break;
    }

    case WStype_DISCONNECTED:
      Serial.printf("App disconnected. Client #%d\n", clientNum);
      if (connectedClient == clientNum) connectedClient = -1;
      break;

    case WStype_TEXT: {
      Serial.printf("← App: %s\n", payload);

      // Parse the JSON command
      JsonDocument doc;
      DeserializationError err = deserializeJson(doc, payload, length);
      if (err) {
        Serial.println("Bad JSON, ignoring");
        break;
      }

      const char* msgType = doc["type"];
      if (!msgType) break;

      // ── display command ──────────────────────────────
      // Example: {"type":"display","letter":"H"}
      if (strcmp(msgType, "display") == 0) {
        const char* letterStr = doc["letter"];
        if (letterStr && strlen(letterStr) >= 1) {
          char letter = toupper((unsigned char)letterStr[0]);
          if (letter >= 'A' && letter <= 'Z') {
            uint8_t idx = letter - 'A';

            if (currentState == DISPLAYING || currentState == PUNCHING) {
              // Clean transition: drop all dots first
              clearDisplay();
              currentState    = TRANSITIONING;
              transitionStart = millis();
              pendingLetter   = (int8_t)idx;
            } else {
              showLetter(idx);
            }
          }
        }
      }

      break;
    }

    default:
      break;
  }
}

// ── WiFi ─────────────────────────────────────────────────
void setupWiFi() {
  Serial.printf("Connecting to: %s\n", WIFI_SSID);
  WiFi.begin(WIFI_SSID, WIFI_PASS);

  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED && attempts < 30) {
    delay(500);
    Serial.print(".");
    attempts++;
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("\n\nWiFi connected!");
    Serial.print(">>> Device IP: ");
    Serial.println(WiFi.localIP());
    Serial.println(">>> Type this IP into the mobile app\n");
  } else {
    Serial.println("\nWiFi failed — check SSID and password");
  }
}

// ── Setup ─────────────────────────────────────────────────
void setup() {
  Serial.begin(115200);
  delay(500);
  Serial.println("\n============ BRAILLE D.O.T.S ============");

  // GPIO
  pinMode(PIN_DATA,   OUTPUT);
  pinMode(PIN_CLOCK,  OUTPUT);
  pinMode(PIN_LATCH,  OUTPUT);
  pinMode(PIN_OE,     OUTPUT);
  pinMode(PIN_LED,    OUTPUT);
  pinMode(BTN_NEXT,   INPUT_PULLUP);
  pinMode(BTN_BACK,   INPUT_PULLUP);
  pinMode(BTN_ANSWER, INPUT_PULLUP);

  clearDisplay();

  // Network
  setupWiFi();
  webSocket.begin();
  webSocket.onEvent(onWebSocketEvent);

  Serial.println("WebSocket server ready on port 81");
  Serial.println("Waiting for mobile app to connect...");
  Serial.println("=========================================\n");
}

// ── Loop ──────────────────────────────────────────────────
void loop() {
  webSocket.loop(); // Must be called every iteration

  unsigned long now = millis();

  // ── Buttons ─────────────────────────────────────────
  if (now - lastButtonPress >= DEBOUNCE_MS
      && currentState != TRANSITIONING) {

    if (digitalRead(BTN_NEXT) == LOW) {
      lastButtonPress = now;
      sendToApp("{\"type\":\"button_press\",\"button\":\"next\"}");
    }
    else if (digitalRead(BTN_BACK) == LOW) {
      lastButtonPress = now;
      sendToApp("{\"type\":\"button_press\",\"button\":\"back\"}");
    }
    else if (digitalRead(BTN_ANSWER) == LOW) {
      lastButtonPress = now;
      sendToApp("{\"type\":\"button_press\",\"button\":\"answer\"}");
    }
  }

  // ── State machine (unchanged from original) ──────────
  switch (currentState) {
    case PUNCHING:
      if (now - punchStartTime >= PUNCH_MS) {
        analogWrite(PIN_OE, 140); // 45% hold power
        currentState = DISPLAYING;
      }
      break;

    case DISPLAYING:
      break; // Holding cool, waiting for next app command

    case TRANSITIONING:
      if (now - transitionStart >= TRANSITION_MS) {
        if (pendingLetter >= 0) {
          showLetter((uint8_t)pendingLetter);
          pendingLetter = -1;
        }
      }
      break;
  }
}