#pragma once

#include <Arduino.h>
#include "config.h"

class RelayController {
private:
  bool isActiveHigh;
  unsigned long lastPulseTime = 0;
  int pulseDuration = PULSE_DURATION_MS;
  bool pulsing = false;

public:
  void begin() {
    pinMode(RELAY_PIN, OUTPUT);
    digitalWrite(RELAY_PIN, isActiveHigh ? LOW : HIGH);

    pinMode(LED_RELAY_PIN, OUTPUT);
    digitalWrite(LED_RELAY_PIN, LOW);

    Serial.printf("[RELAY] Initialized on GPIO %d (active %s)\n",
                  RELAY_PIN, isActiveHigh ? "HIGH" : "LOW");
  }

  /**
   * Pulse the relay for the given duration.
   * Activates immediately, deactivates after duration_ms.
   */
  void pulse(int durationMs = PULSE_DURATION_MS) {
    if (pulsing) {
      Serial.println("[RELAY] Already pulsing, ignoring");
      return;
    }

    pulseDuration = durationMs;
    pulsing = true;
    lastPulseTime = millis();

    digitalWrite(RELAY_PIN, isActiveHigh ? HIGH : LOW);
    digitalWrite(LED_RELAY_PIN, HIGH);

    Serial.printf("[RELAY] PULSED for %d ms\n", durationMs);

    logEvent("RELAY_ON");
  }

  /**
   * Call from loop() to auto-deactivate after pulse duration.
   */
  void update() {
    if (pulsing && (millis() - lastPulseTime >= (unsigned long)pulseDuration)) {
      digitalWrite(RELAY_PIN, isActiveHigh ? LOW : HIGH);
      digitalWrite(LED_RELAY_PIN, LOW);
      pulsing = false;
      Serial.println("[RELAY] Deactivated");
      logEvent("RELAY_OFF");
    }
  }

  bool isPulsing() const { return pulsing; }

  void setActiveHigh(bool high) { isActiveHigh = high; }

  /**
   * Local event log (write to Serial / SD card in production).
   * For a real deployment, this would write to an SD card or SPIFFS.
   */
  void logEvent(const char* event) {
    unsigned long ts = millis();
    Serial.printf("[LOG] %lu ms - %s\n", ts, event);
    // TODO: Write to SD card or SPIFFS:
    // File f = SD.open("/gate_log.csv", FILE_APPEND);
    // f.printf("%lu,%s\n", ts, event);
    // f.close();
  }
};
