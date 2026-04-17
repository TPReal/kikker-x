#pragma once

#include <stdint.h>

#include <memory>
#include <string>
#include <vector>

using std::string;
using std::unique_ptr;
using std::vector;

// Bump when the config schema changes in a breaking way.
// Adding optional fields with defaults does NOT require a bump.
#define CONFIG_SCHEMA_VERSION 2

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
  string username;  // empty to disable auth
  string password_sha256;  // SHA-256 of the password, hex lowercase
};

struct WifiEntry {
  string ssid;
  string password;
  string static_ip;  // empty = DHCP
  string subnet_mask;  // empty = 255.255.255.0
  string gateway;  // empty = use static_ip
  string dns;  // empty = 8.8.8.8
};

struct ApFallback {
  string ssid;  // empty = not configured
  string password;  // empty = open network
};

struct cJSON;

// Parsed config. All string data is owned via string — no external backing memory.
// Always represents a fully-specified, valid config. Construct via Config::fromJSON,
// which returns null on parse failure — there is no broken/empty Config state.
class Config {
 public:
  // Parses JSON into a Config. Returns null if the JSON fails to parse.
  // When log is true, emits a summary of wifi entries and AP fallback on successful parse
  // — used by getActiveConfig to log only the chosen source, not inspection reads.
  static unique_ptr<Config> fromJSON(const char* configJSON, bool log = false);

  string mdns;  // empty to disable mDNS, otherwise registered as <value>.local
  vector<WifiEntry> wifi_entries;
  ApFallback ap_fallback;  // ap_fallback.ssid.empty() = not configured
  bool allow_cors = true;  // send Access-Control-Allow-Origin headers
  AuthConfig auth;  // auth.username.empty() → auth disabled
  bool allow_ota = true;  // allow firmware updates via POST /api/firmware

  string redactedJSON;  // defaults-filled, passwords masked; for the config endpoint

 private:
  Config(cJSON* src, bool log);
};

struct ConfigInfo {
  uint16_t schema_version = 0;  // schema version, or 0 if absent
  unique_ptr<Config> config;  // null when unavailable (absent, wrong schema_version, or parse failed)
  bool is_active = false;  // set by getActiveConfig: policy keeps this source in sync this boot
                           // (either read, or written by a STORE_* policy)
};

// Embedded config. Cached. version == 0 when not applicable (LOAD_OR_USE_DEFAULT, LOAD_OR_FAIL).
// log is forwarded to the first-time parse; later calls ignore it (cached result wins).
const ConfigInfo& getEmbeddedConfig(bool log = false);

// Stored (NVS) config. Cached. version == 0 when NVS has no config.
// Config is filled only when version == CONFIG_SCHEMA_VERSION.
const ConfigInfo& getStoredConfig(bool log = false);

// Picks the active config from embedded/stored based on CONFIG_POLICY.
// Not cached — just dispatches to the cached getters above.
// One-time side effects: NVS save for STORE policies, shutdown for LOAD_OR_FAIL.
// Also marks the relevant sources' is_active flag on their ConfigInfos.
const Config& getActiveConfig();

// Firmware defaults — a ConfigInfo wrapping a Config built from "{}". Cached.
const ConfigInfo& getFirmwareDefaults(bool log = false);

// Returns the CONFIG_POLICY name as a string (e.g. "STORE_EMBEDDED").
const char* getConfigPolicyName();

// "embedded", "stored", or "default" — which source getActiveConfig() selected.
const char* getConfigActiveSource();
