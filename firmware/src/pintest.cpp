// Wiring test, one state per upload:
//   pio run -e state1 -t upload   (then state2 ... state5)
//
// Safety (state 3/4 once overheated the coils: only the first 595 was
// written, the other 4 kept random data with OE enabled):
//   - every write shifts ALL 5 chips (zeros for every cell not being tested)
//   - all 5 are cleared in setup() before OE can go low
//   - states 4/5: one coil at a time, ON_MS on, then REST_MS with OE off
//   - state 3: turns itself off after STATE3_MS
//   - after HARD_LIMIT_MS everything is off for good, until reset
#include <Arduino.h>
#define PIN_DATA 23
#define PIN_CLOCK 18
#define PIN_LATCH 21
#define PIN_OE 25 // active LOW: HIGH = all outputs off
#define NUM_CELLS 5
#ifndef STATE
#define STATE 1
#endif

#define ON_MS 300               // one coil on
#define REST_MS 1200            // everything off between coils
#define STATE3_MS 10000UL       // state 3 turns itself off after this
#define HARD_LIMIT_MS 180000UL  // 3 min: everything off until reset

bool stopped = false;

// One byte per cell (dots 1-6 in bits 0-5), all 5 chips every time.
// The FIRST byte shifted ends up in the LAST chip, so cell 5 goes first.
// Dots 1-6 are on Q2-Q7, hence the << 2 (same as main.cpp).
void writeCells(const uint8_t *pats) {
  digitalWrite(PIN_LATCH, LOW);
  for (int c = NUM_CELLS - 1; c >= 0; c--)
    shiftOut(PIN_DATA, PIN_CLOCK, MSBFIRST, (pats[c] & 0x3F) << 2);
  digitalWrite(PIN_LATCH, HIGH);
}

void allOff() {
  digitalWrite(PIN_OE, HIGH);
  uint8_t zeros[NUM_CELLS] = {0};
  writeCells(zeros);
}

// True (and everything off) once the hard limit is reached
bool timeUp() {
  if (!stopped && millis() >= HARD_LIMIT_MS) {
    allOff();
    stopped = true;
    Serial.println("HARD LIMIT: 3 min reached, everything OFF. Press reset to test again.");
  }
  return stopped;
}

// One coil of one cell (cell 0-4, dot 0-5): ON_MS on, then REST_MS off
void pulse(int cell, int dot) {
  if (timeUp()) return;
  uint8_t pats[NUM_CELLS] = {0};
  pats[cell] = 1 << dot;
  Serial.printf("cell %d dot %d up\n", cell + 1, dot + 1);
  writeCells(pats);
  digitalWrite(PIN_OE, LOW);
  delay(ON_MS);
  allOff();
  delay(REST_MS);
}

void setup() {
  // Outputs off and all 5 chips cleared before anything else
  pinMode(PIN_OE, OUTPUT); digitalWrite(PIN_OE, HIGH);
  pinMode(PIN_DATA, OUTPUT); pinMode(PIN_CLOCK, OUTPUT); pinMode(PIN_LATCH, OUTPUT);
  allOff();
  Serial.begin(115200); delay(500);

#if STATE == 1
  digitalWrite(PIN_OE, HIGH); // stays off; DATA/CLOCK only shift, nothing is latched
  digitalWrite(PIN_DATA, HIGH); digitalWrite(PIN_CLOCK, HIGH);
  digitalWrite(PIN_LATCH, HIGH);
  Serial.println("STATE 1: all lines HIGH -> 595 pins 11,12,13,14 should be ~3.3V");
#elif STATE == 2
  digitalWrite(PIN_DATA, LOW); digitalWrite(PIN_CLOCK, LOW);
  digitalWrite(PIN_LATCH, LOW); digitalWrite(PIN_OE, LOW); // all 5 chips hold zeros
  Serial.println("STATE 2: all lines LOW -> 595 pins 11,12,13,14 should be ~0V");
#elif STATE == 3
  {
    uint8_t pats[NUM_CELLS] = {0};
    pats[0] = 0x3F; // cell 1: dots 1-6 (Q2-Q7); cells 2-5 off
    writeCells(pats);
    digitalWrite(PIN_OE, LOW);
    Serial.printf("STATE 3: cell 1 outputs ON for %lu s -> 595 #1 pins 2-7 should be ~3.3V "
                  "(solenoid supply OFF!)\n", STATE3_MS / 1000);
    delay(STATE3_MS);
    allOff();
    Serial.println("STATE 3: everything OFF");
  }
#elif STATE == 4
  Serial.println("STATE 4: dots of cell 1, one at a time (solenoid supply ON)");
#elif STATE == 5
  Serial.println("STATE 5: map test, every dot of every cell, one at a time (solenoid supply ON)");
#endif
}

void loop() {
  if (timeUp()) {
    digitalWrite(PIN_OE, HIGH); // stay off until reset
    delay(1000);
    return;
  }
#if STATE == 4
  for (int d = 0; d < 6; d++) pulse(0, d);
#elif STATE == 5
  for (int c = 0; c < NUM_CELLS; c++)
    for (int d = 0; d < 6; d++) pulse(c, d);
#else
  delay(50);
#endif
}
