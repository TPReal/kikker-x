#include "auth.h"

#include <mbedtls/base64.h>
#include <mbedtls/sha256.h>

#include "config.h"

bool authCheck(const String& authHeader) {
  if (getConfig().auth.username == nullptr)
    return true;

  if (!authHeader.startsWith("Basic "))
    return false;

  // Decode base64 payload → "username:password"
  String b64 = authHeader.substring(6);
  unsigned char decoded[128];
  size_t decodedLen = 0;
  if (mbedtls_base64_decode(decoded, sizeof(decoded), &decodedLen, (const unsigned char*)b64.c_str(), b64.length()) !=
      0)
    return false;

  // Split at the first colon
  int colon = -1;
  for (size_t i = 0; i < decodedLen; i++) {
    if (decoded[i] == ':') {
      colon = (int)i;
      break;
    }
  }
  if (colon < 0)
    return false;

  // Verify username (constant-time length + content check)
  size_t userLen = (size_t)colon;
  if (userLen != strlen(getConfig().auth.username) || memcmp(decoded, getConfig().auth.username, userLen) != 0)
    return false;

  // SHA-256 the received password
  const unsigned char* pwd = decoded + colon + 1;
  size_t pwdLen = decodedLen - colon - 1;
  unsigned char hash[32];
  mbedtls_sha256_context ctx;
  mbedtls_sha256_init(&ctx);
  mbedtls_sha256_starts(&ctx, 0);  // 0 = SHA-256
  mbedtls_sha256_update(&ctx, pwd, pwdLen);
  mbedtls_sha256_finish(&ctx, hash);
  mbedtls_sha256_free(&ctx);

  // Format as lowercase hex and compare
  char hashHex[65];
  for (int i = 0; i < 32; i++)
    snprintf(hashHex + i * 2, 3, "%02x", hash[i]);
  hashHex[64] = '\0';

  // Constant-time compare — both strings are always exactly 64 hex chars.
  const char* stored = getConfig().auth.pass_sha256;
  if (!stored)
    return false;
  int diff = 0;
  for (int i = 0; i < 64; i++)
    diff |= hashHex[i] ^ stored[i];
  return diff == 0;
}

void authDeny(WiFiClient& client) {
  client.print(
      "HTTP/1.1 401 Unauthorized\r\n"
      "WWW-Authenticate: Basic realm=\"KikkerX\"\r\n"
      "Connection: close\r\n\r\n");
  client.stop();
  Serial.println("→ 401");
}
