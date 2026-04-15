#pragma once

// Bump when the config schema changes in a breaking way.
// Adding optional fields with defaults does NOT require a bump.
#define CONFIG_VERSION 2

// Config policies — ordered by NVS involvement.
// The active policy is set at build time via -DCONFIG_POLICY=N by prepare_config.py.
#define CONFIG_POLICY_USE_EMBEDDED 0  // Use embedded config, don't touch NVS.
#define CONFIG_POLICY_STORE_EMBEDDED 1  // Use embedded config, save to NVS.
#define CONFIG_POLICY_LOAD_OR_USE_EMBEDDED 2  // Try NVS, fall back to embedded config.
#define CONFIG_POLICY_LOAD_OR_STORE_EMBEDDED 3  // Try NVS, fall back to embedded config + save.
#define CONFIG_POLICY_LOAD_OR_USE_DEFAULT 4  // Try NVS, fall back to firmware defaults.
#define CONFIG_POLICY_LOAD_OR_FAIL 5  // Try NVS, shut down if unavailable.

#ifndef CONFIG_POLICY
#define CONFIG_POLICY CONFIG_POLICY_USE_EMBEDDED
#endif

struct AuthConfig {
  const char* username;  // nullptr to disable auth entirely
  const char* password_sha256;  // SHA-256 of the password, hex lowercase
};

struct WifiEntry {
  const char* ssid;
  const char* password;
  const char* static_ip;  // nullptr = DHCP
  const char* subnet_mask;  // nullptr = 255.255.255.0
  const char* gateway;  // nullptr = ip
  const char* dns;  // nullptr = 8.8.8.8
};

struct ApFallback {
  const char* ssid;
  const char* password;  // nullptr = open network
};

struct Config {
  const char* mdns;  // nullptr to disable mDNS, otherwise registered as <value>.local
  const WifiEntry* wifi_entries;
  int num_wifi_entries;
  const ApFallback* ap_fallback;  // nullptr if not configured
  bool allow_cors;  // send Access-Control-Allow-Origin headers; default true
  AuthConfig auth;  // auth.username == nullptr → auth disabled
  bool allow_ota;  // allow firmware updates via POST /api/firmware; default true
};

// Parse the embedded _config.json and return a filled Config.
// Result is cached; safe to call from multiple places.
Config getConfig();

// Returns the CONFIG_POLICY name as a string (e.g. "STORE_EMBEDDED").
const char* getConfigPolicyName();
