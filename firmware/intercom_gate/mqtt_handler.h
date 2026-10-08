#pragma once

#include <WiFi.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include "config.h"
#include "gpio_relay.h"
#include "signature.h"

class MqttGateHandler {
private:
  WiFiClient wifiClient;
  PubSubClient mqtt;
  RelayController& relay;
  unsigned long lastStatusTime = 0;
  unsigned long lastReconnectAttempt = 0;

  void onMessage(char* topic, byte* payload, unsigned int length) {
    String message;
    for (unsigned int i = 0; i < length; i++) {
      message += (char)payload[i];
    }

    Serial.printf("[MQTT] Received on %s: %s\n", topic, message.c_str());

    JsonDocument doc;
    DeserializationError err = deserializeJson(doc, message);
    if (err) {
      Serial.printf("[MQTT] JSON parse error: %s\n", err.c_str());
      return;
    }

    String action = doc["action"] | "";
    if (action != "pulse_relay") {
      Serial.printf("[MQTT] Unknown action: %s\n", action.c_str());
      return;
    }

    // Verify HMAC signature
    String gateId = doc["gate_id"] | "";
    String residentId = doc["resident_id"] | "";
    String callId = doc["call_id"] | "";
    unsigned long timestamp = doc["timestamp"] | 0UL;
    int durationMs = doc["duration_ms"] | PULSE_DURATION_MS;
    String signature = doc["signature"] | "";

    if (gateId != GATE_ID) {
      Serial.printf("[MQTT] Gate ID mismatch: expected %s, got %s\n",
                    GATE_ID, gateId.c_str());
      return;
    }

    if (!SignatureVerifier::verifyPayload(gateId, residentId, callId,
                                           timestamp, durationMs, signature)) {
      Serial.println("[MQTT] SIGNATURE VERIFICATION FAILED - rejecting command");
      publishStatus("signature_failed");
      return;
    }

    // Signature valid — execute relay pulse
    Serial.printf("[MQTT] Valid unlock from resident %s (call %s)\n",
                  residentId.c_str(), callId.c_str());
    relay.pulse(durationMs);
    publishStatus("unlocked");
  }

  void publishStatus(const char* event) {
    JsonDocument doc;
    doc["gate_id"] = GATE_ID;
    doc["status"] = event;
    doc["uptime_ms"] = millis();
    doc["relay_active"] = relay.isPulsing();

    char buffer[256];
    serializeJson(doc, buffer);
    mqtt.publish(MQTT_TOPIC_STATUS, buffer);
  }

  bool connect() {
    Serial.printf("[MQTT] Connecting to %s:%d ...",
                  MQTT_BROKER_URL, MQTT_BROKER_PORT);

    bool connected = mqtt.connect(
      MQTT_CLIENT_ID,
      strlen(MQTT_USERNAME) > 0 ? MQTT_USERNAME : NULL,
      strlen(MQTT_PASSWORD) > 0 ? MQTT_PASSWORD : NULL,
      MQTT_TOPIC_STATUS, 1, true, "{\"status\":\"offline\"}"
    );

    if (connected) {
      Serial.println(" connected!");
      mqtt.subscribe(MQTT_TOPIC_COMMAND);
      Serial.printf("[MQTT] Subscribed to %s\n", MQTT_TOPIC_COMMAND);
      digitalWrite(LED_MQTT_PIN, HIGH);
      publishStatus("online");
    } else {
      Serial.printf(" failed (rc=%d)\n", mqtt.state());
      digitalWrite(LED_MQTT_PIN, LOW);
    }

    return connected;
  }

public:
  MqttGateHandler(RelayController& relayController)
    : mqtt(wifiClient), relay(relayController) {}

  void begin() {
    mqtt.setServer(MQTT_BROKER_URL, MQTT_BROKER_PORT);
    mqtt.setBufferSize(512);
    mqtt.setCallback([this](char* t, byte* p, unsigned int l) {
      this->onMessage(t, p, l);
    });
  }

  void connectWiFi() {
    Serial.printf("[WIFI] Connecting to %s ", WIFI_SSID);
    WiFi.mode(WIFI_STA);
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

    unsigned long start = millis();
    while (WiFi.status() != WL_CONNECTED &&
           millis() - start < WIFI_CONNECT_TIMEOUT_MS) {
      Serial.print(".");
      delay(500);
    }

    if (WiFi.status() == WL_CONNECTED) {
      Serial.printf("\n[WIFI] Connected! IP: %s\n",
                    WiFi.localIP().toString().c_str());
      digitalWrite(LED_WIFI_PIN, HIGH);
    } else {
      Serial.println("\n[WIFI] Connection failed!");
      digitalWrite(LED_WIFI_PIN, LOW);
    }
  }

  void update() {
    // Reconnect MQTT if needed
    if (WiFi.status() == WL_CONNECTED) {
      if (!mqtt.connected()) {
        unsigned long now = millis();
        if (now - lastReconnectAttempt > RECONNECT_INTERVAL_MS) {
          lastReconnectAttempt = now;
          connect();
        }
      } else {
        mqtt.loop();
      }
    }

    // Publish periodic status
    unsigned long now = millis();
    if (now - lastStatusTime > STATUS_INTERVAL_MS && mqtt.connected()) {
      lastStatusTime = now;
      publishStatus("heartbeat");
    }
  }

  bool isConnected() { return mqtt.connected(); }
};
