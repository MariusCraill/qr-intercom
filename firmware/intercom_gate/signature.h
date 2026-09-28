#pragma once

#include <Arduino.h>
#include <mbedtls/md.h>
#include <mbedtls/error.h>
#include "config.h"

class SignatureVerifier {
public:
  /**
   * Compute HMAC-SHA256 of the given data using the shared secret.
   * Returns the hex-encoded signature string.
   */
  static String computeHMAC(const String& data) {
    unsigned char hmacResult[32];
    mbedtls_md_context_t ctx;
    mbedtls_md_init(&ctx);
    mbedtls_md_setup(&ctx, mbedtls_md_info_from_type(MBEDTLS_MD_SHA256), 1);
    mbedtls_md_hmac_starts(&ctx,
      (const unsigned char*)HMAC_SECRET, strlen(HMAC_SECRET));
    mbedtls_md_hmac_update(&ctx,
      (const unsigned char*)data.c_str(), data.length());
    mbedtls_md_hmac_finish(&ctx, hmacResult);
    mbedtls_md_free(&ctx);

    char hexStr[65];
    for (int i = 0; i < 32; i++) {
      sprintf(hexStr + (i * 2), "%02x", hmacResult[i]);
    }
    hexStr[64] = '\0';
    return String(hexStr);
  }

  /**
   * Verify the signature of a command payload.
   * Expected payload fields: gate_id, resident_id, call_id, timestamp, duration_ms
   * The server signs: "gate_id:resident_id:call_id:timestamp:duration_ms"
   */
  static bool verifyPayload(const String& gateId,
                            const String& residentId,
                            const String& callId,
                            unsigned long timestamp,
                            int durationMs,
                            const String& receivedSignature) {
    // Reject if timestamp is older than 30 seconds (replay protection)
    unsigned long now = millis();
    if (now > timestamp + 30000 || timestamp > now + 5000) {
      Serial.println("[SIG] Timestamp rejected (possible replay)");
      return false;
    }

    String data = gateId + ":" + residentId + ":" + callId +
                  ":" + String(timestamp) + ":" + String(durationMs);
    String expectedSig = computeHMAC(data);

    // Constant-time comparison
    if (expectedSig.length() != receivedSignature.length()) return false;
    volatile uint8_t diff = 0;
    for (size_t i = 0; i < expectedSig.length(); i++) {
      diff |= (uint8_t)(expectedSig[i] ^ receivedSignature[i]);
    }
    return diff == 0;
  }
};
