#pragma once

#include <Arduino.h>
#include <WiFi.h>

#include <string>

// Returns true if the Authorization header value passes Basic Auth.
// Compares SHA-256(received_password) against AUTH_PASSWORD_SHA256 from config.h.
bool authCheck(const String& authHeader);

// Sends 401 Unauthorized with a WWW-Authenticate challenge and closes the connection.
// Adds CORS headers when origin is non-empty.
void authDeny(WiFiClient& client, const String& origin);

// Lowercase hex-encoded SHA-256 of `len` bytes at `data` (always 64 chars).
std::string sha256Hex(const void* data, size_t len);
