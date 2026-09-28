#pragma once

// ── Wi-Fi ───────────────────────────────────────────────────────────
#define WIFI_SSID           "YourSSID"
#define WIFI_PASSWORD       "YourPassword"
#define WIFI_CONNECT_TIMEOUT_MS  10000

// ── MQTT ────────────────────────────────────────────────────────────
#define MQTT_BROKER_URL     "192.168.1.100"
#define MQTT_BROKER_PORT    1883
#define MQTT_CLIENT_ID      "esp32_gate_001"
#define MQTT_USERNAME       ""
#define MQTT_PASSWORD       ""

// Gate-specific topic — must match server config
#define GATE_ID             "your-gate-uuid-here"
#define MQTT_TOPIC_COMMAND  "intercom/gate/" GATE_ID "/command"
#define MQTT_TOPIC_STATUS   "intercom/gate/" GATE_ID "/status"

// ── HMAC Shared Secret ──────────────────────────────────────────────
// Must match the server's mqttGateSecret
#define HMAC_SECRET         "shared-hmac-secret-change-me"

// ── Relay GPIO ──────────────────────────────────────────────────────
#define RELAY_PIN           26
#define RELAY_ACTIVE_HIGH   true

// ── Timing ──────────────────────────────────────────────────────────
#define PULSE_DURATION_MS   500
#define STATUS_INTERVAL_MS  30000
#define RECONNECT_INTERVAL_MS 5000

// ── LED Indicators ──────────────────────────────────────────────────
#define LED_WIFI_PIN        2
#define LED_MQTT_PIN        4
#define LED_RELAY_PIN       15
