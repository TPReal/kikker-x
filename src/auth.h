#pragma once

#include <Arduino.h>
#include <WiFi.h>

// Returns true if the Authorization header value passes Basic Auth.
// Compares SHA-256(received_password) against AUTH_PASSWORD_SHA256 from config.h.
bool authCheck(const String& authHeader);

// Sends 401 Unauthorized with a WWW-Authenticate challenge and closes the connection.
void authDeny(WiFiClient& client);
