#pragma once

struct AuthConfig {
  const char* username;  // nullptr to disable auth entirely
  const char* pass_sha256;  // SHA-256 of the password, hex lowercase
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
  AuthConfig auth;  // auth.username == nullptr → auth disabled
  const WifiEntry* wifi_entries;
  int num_wifi_entries;
  const ApFallback* ap_fallback;  // nullptr if not configured
};

// Parse the embedded _config.json and return a filled Config.
// Result is cached; safe to call from multiple places.
Config getConfig();
