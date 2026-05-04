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
  string password;  // empty = open AP; AP_FALLBACK_RANDOM_TOKEN = generate per-boot; else explicit passphrase
};

// Sentinel value that means "generate a random AP password each boot". Stored verbatim in
// ap_fallback.password; wifi_connect resolves it to an actual password when starting the AP.
extern const char* const AP_FALLBACK_RANDOM_TOKEN;

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

  // Copyable — needed so we can snapshot the active config independently of the
  // stored/embedded/defaults caches (which may be replaced by stored-config edits).
  Config(const Config&) = default;
  Config& operator=(const Config&) = default;

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
  bool is_modified = false;  // set on the stored source after a successful PATCH/PUT/DELETE —
                             // means NVS no longer matches what's running in RAM
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

// Active running config — snapshot taken at boot. Owned independently of the
// stored/embedded/defaults caches so edits to `stored` do not disturb it.
// is_active is always true here.
const ConfigInfo& getActiveConfigInfo();

// True when the active CONFIG_POLICY reads NVS at runtime (LOAD_OR_* policies).
// The edit endpoints reject with 405 when this is false.
bool canEditStoredConfig();

// Applies an RFC 7396-style JSON merge patch to the stored config in NVS.
// Objects are deep-merged, arrays replaced wholesale, null clears a key (reset to default).
// Creates the stored config if NVS is empty or has a bad schema_version.
// On success: NVS is updated, s_stored is re-parsed, is_modified is set, is_active is cleared.
// Returns "" on success or a human-readable error on failure (leaves NVS untouched).
string patchStoredConfig(const char* patchJson);

// Replaces the whole stored config with an empty object (reset everything to defaults).
// Semantically a DELETE — clears the NVS entry. Returns "" on success.
string deleteStoredConfig();

// Adds or replaces a single known_networks entry, matched by SSID.
// Returns "" on success.
string putKnownNetwork(const char* entryJson);

// Removes the known_networks entry matching `ssid`. No-op (still returns "")
// if no entry matches — endpoint is idempotent.
string deleteKnownNetwork(const char* ssid);

// Resets the stored config to a baseline source: "embedded" (firmware-embedded JSON)
// or "default" (firmware defaults, equivalent to "{}"). Returns "" on success.
string copyStoredFrom(const char* source);

// Returns the CONFIG_POLICY name as a string (e.g. "STORE_EMBEDDED").
const char* getConfigPolicyName();

// "embedded", "stored", or "default" — which source getActiveConfig() selected.
const char* getConfigActiveSource();
