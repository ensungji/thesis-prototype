// Wiring test, one state per upload:
//   pio run -e state1 -t upload   (then state2, state3, state4)
#include <Arduino.h>
#define PIN_DATA  23
#define PIN_CLOCK 18
#define PIN_LATCH 21
#define PIN_OE    25
#ifndef STATE
#define STATE 1
#endif

void latch(uint8_t pat) {
  digitalWrite(PIN_LATCH, LOW);
  shiftOut(PIN_DATA, PIN_CLOCK, MSBFIRST, pat);
  digitalWrite(PIN_LATCH, HIGH);
}

void setup() {
  pinMode(PIN_OE, OUTPUT); digitalWrite(PIN_OE, HIGH);
  pinMode(PIN_DATA, OUTPUT); pinMode(PIN_CLOCK, OUTPUT); pinMode(PIN_LATCH, OUTPUT);
  latch(0);
  Serial.begin(115200); delay(500);

#if STATE == 1
  digitalWrite(PIN_DATA, HIGH); digitalWrite(PIN_CLOCK, HIGH);
  digitalWrite(PIN_LATCH, HIGH); digitalWrite(PIN_OE, HIGH);
  Serial.println("STATE 1: all lines HIGH -> 595 pins 11,12,13,14 should be ~3.3V");
#elif STATE == 2
  digitalWrite(PIN_DATA, LOW); digitalWrite(PIN_CLOCK, LOW);
  digitalWrite(PIN_LATCH, LOW); digitalWrite(PIN_OE, LOW);
  Serial.println("STATE 2: all lines LOW -> 595 pins 11,12,13,14 should be ~0V");
#elif STATE == 3
  latch(0b11111100);           // Q2-Q7 on
  digitalWrite(PIN_OE, LOW);   // outputs enabled
  Serial.println("STATE 3: outputs ON -> 595 pins 2-7 should be ~3.3V (solenoid supply OFF!)");
#endif
}

void loop() {
#if STATE == 4
  // Dots test (solenoid supply ON): each dot of cell 1 up for 0.5 s, one at a time
  digitalWrite(PIN_OE, LOW);
  for (int d = 0; d < 6; d++) {
    Serial.printf("STATE 4: dot %d up\n", d + 1);
    latch(1 << (d + 2)); delay(500);
    latch(0);            delay(1000);
  }
#endif
}