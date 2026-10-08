/**
 * QR Intercom - ESP32 Gate Controller Firmware
 *
 * Subscribes to MQTT gate command channel.
 * Verifies HMAC-signed unlock payloads.
 * Pulses relay GPIO to trigger gate controller.
 * Publishes status heartbeats and events.
 *
 * Hardware wiring:
 *   GPIO 26 -> Relay IN (gate controller)
 *   GPIO  2 -> WiFi LED indicator
 *   GPIO  4 -> MQTT LED indicator
 *   GPIO 15 -> Relay pulse LED indicator
 */

#include "config.h"
#include "gpio_relay.h"
#include "mqtt_handler.h"

RelayController relay;
MqttGateHandler gateMqtt(relay);

void setup() {
  Serial.begin(115200);
  delay(100);

  Serial.println("========================================");
  Serial.println("  QR Intercom Gate Controller v1.0.0");
  Serial.printf("  Gate ID: %s\n", GATE_ID);
  Serial.println("========================================");

  // Status LEDs
  pinMode(LED_WIFI_PIN, OUTPUT);
  pinMode(LED_MQTT_PIN, OUTPUT);
  digitalWrite(LED_WIFI_PIN, LOW);
  digitalWrite(LED_MQTT_PIN, LOW);

  // Relay
  relay.setActiveHigh(RELAY_ACTIVE_HIGH);
  relay.begin();
  relay.logEvent("BOOT");

  // Network
  gateMqtt.begin();
  gateMqtt.connectWiFi();

  relay.logEvent("SETUP_COMPLETE");
}

void loop() {
  relay.update();
  gateMqtt.update();
  delay(10);
}
