// INCBIN must be configured before incbin.h is included.
#define INCBIN_PREFIX
#define INCBIN_STYLE INCBIN_STYLE_SNAKE
#include "config.h"

#include <cJSON.h>
#include <esp_random.h>
#include <esp_sleep.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include <incbin.h>
#include <nvs_flash.h>
#include <string.h>

#include "auth.h"
#include "log.h"

INCBIN(config_json, "src/_config.json");

static const char* s_active_source = "embedded";

// ---------------------------------------------------------------------------
// NVS helpers
// ---------------------------------------------------------------------------

static const char* NVS_NS = "config";
static const char* NVS_KEY_SCHEMA_VERSION = "schema_version";
static const char* NVS_KEY_JSON = "json";

// Check if NVS has a config. If so, fill *ver_out. Returns false when absent.
static bool nvsReadVersion(uint16_t* ver_out) {
  *ver_out = 0;
  nvs_handle_t h;
  if (nvs_open(NVS_NS, NVS_READONLY, &h) != ESP_OK) {
    return false;
  }
  nvs_get_u16(h, NVS_KEY_SCHEMA_VERSION, ver_out);
  size_t len = 0;
  bool has = (nvs_get_str(h, NVS_KEY_JSON, nullptr, &len) == ESP_OK && len > 0);
  nvs_close(h);
  return has;
}

// Load the raw JSON from NVS. Returns a malloc'd string, or nullptr.
static char* nvsLoadJSON() {
  nvs_handle_t h;
  if (nvs_open(NVS_NS, NVS_READONLY, &h) != ESP_OK) {
    return nullptr;
  }
  size_t len = 0;
  if (nvs_get_str(h, NVS_KEY_JSON, nullptr, &len) != ESP_OK || len == 0) {
    nvs_close(h);
    return nullptr;
  }
  char* buf = (char*)malloc(len);
  if (!buf) {
    nvs_close(h);
    return nullptr;
  }
  nvs_get_str(h, NVS_KEY_JSON, buf, &len);
  nvs_close(h);
  return buf;
}

static void nvsSave(const char* json) {
  nvs_handle_t h;
  if (nvs_open(NVS_NS, NVS_READWRITE, &h) != ESP_OK) {
    Log.println("config: failed to open NVS for writing");
    return;
  }
  nvs_set_u16(h, NVS_KEY_SCHEMA_VERSION, CONFIG_SCHEMA_VERSION);
  nvs_set_str(h, NVS_KEY_JSON, json);
  nvs_commit(h);
  nvs_close(h);
  Log.println("config: saved config to NVS");
}

// ---------------------------------------------------------------------------

static char* embeddedJsonBuf() {
  char* buf = (char*)malloc(config_json_size + 1);
  if (!buf) {
    return nullptr;
  }
  memcpy(buf, config_json_data, config_json_size);
  buf[config_json_size] = '\0';
  return buf;
}

// ---------------------------------------------------------------------------
// Config constructor
// ---------------------------------------------------------------------------

const char* const AP_FALLBACK_RANDOM_TOKEN = "RANDOM";
static const char* DEFAULT_DNS = "8.8.8.8";
static const char* DEFAULT_SUBNET_MASK = "255.255.255.0";

// Copy src[key] to out[key] as a string if present and string-typed; otherwise null.
static void copyStringOrNull(const cJSON* src, cJSON* out, const char* key) {
  cJSON* v = cJSON_GetObjectItemCaseSensitive(src, key);
  if (cJSON_IsString(v)) {
    cJSON_AddStringToObject(out, key, v->valuestring);
  } else {
    cJSON_AddNullToObject(out, key);
  }
}

// Copy src[key] to out[key] as bool; use default if missing or wrong type.
static void copyBoolOrDefault(const cJSON* src, cJSON* out, const char* key, bool default_val) {
  cJSON* v = cJSON_GetObjectItemCaseSensitive(src, key);
  cJSON_AddBoolToObject(out, key, cJSON_IsBool(v) ? cJSON_IsTrue(v) : default_val);
}

unique_ptr<Config> Config::fromJSON(const char* configJSON, bool log) {
  cJSON* src = cJSON_Parse(configJSON);
  if (!src) {
    Log.println("config: JSON parse failed");
    return nullptr;
  }
  unique_ptr<Config> c(new Config(src, log));
  cJSON_Delete(src);
  return c;
}

Config::Config(cJSON* src, bool log) {
  // --- 1. Build a canonical tree from src, dropping unknown keys, filling defaults ---

  cJSON* tree = cJSON_CreateObject();

  copyStringOrNull(src, tree, "mdns");

  cJSON* treeNets = cJSON_AddArrayToObject(tree, "known_networks");
  cJSON* srcNets = cJSON_GetObjectItemCaseSensitive(src, "known_networks");
  if (cJSON_IsArray(srcNets)) {
    cJSON* srcNet;
    cJSON_ArrayForEach(srcNet, srcNets) {
      cJSON* ssid = cJSON_GetObjectItemCaseSensitive(srcNet, "ssid");
      if (!cJSON_IsString(ssid) || !ssid->valuestring[0]) {
        continue;
      }
      cJSON* treeNet = cJSON_CreateObject();
      cJSON_AddStringToObject(treeNet, "ssid", ssid->valuestring);
      // Open network: missing, null, or empty password — all normalise to null.
      cJSON* pass = cJSON_GetObjectItemCaseSensitive(srcNet, "password");
      if (cJSON_IsString(pass) && pass->valuestring[0]) {
        cJSON_AddStringToObject(treeNet, "password", pass->valuestring);
      } else {
        cJSON_AddNullToObject(treeNet, "password");
      }
      cJSON* ip = cJSON_GetObjectItemCaseSensitive(srcNet, "static_ip");
      if (cJSON_IsString(ip)) {
        cJSON_AddStringToObject(treeNet, "static_ip", ip->valuestring);
        cJSON* sn = cJSON_GetObjectItemCaseSensitive(srcNet, "subnet_mask");
        cJSON* gw = cJSON_GetObjectItemCaseSensitive(srcNet, "gateway");
        cJSON* dns = cJSON_GetObjectItemCaseSensitive(srcNet, "dns");
        cJSON_AddStringToObject(treeNet, "subnet_mask", cJSON_IsString(sn) ? sn->valuestring : DEFAULT_SUBNET_MASK);
        cJSON_AddStringToObject(treeNet, "gateway", cJSON_IsString(gw) ? gw->valuestring : ip->valuestring);
        cJSON_AddStringToObject(treeNet, "dns", cJSON_IsString(dns) ? dns->valuestring : DEFAULT_DNS);
      }
      cJSON_AddItemToArray(treeNets, treeNet);
    }
  }

  cJSON* srcAP = cJSON_GetObjectItemCaseSensitive(src, "fallback_access_point");
  if (cJSON_IsFalse(srcAP)) {
    cJSON_AddFalseToObject(tree, "fallback_access_point");
  } else {
    cJSON* treeAP = cJSON_CreateObject();
    if (cJSON_IsObject(srcAP)) {
      cJSON* ssid = cJSON_GetObjectItemCaseSensitive(srcAP, "ssid");
      cJSON_AddStringToObject(treeAP, "ssid", cJSON_IsString(ssid) ? ssid->valuestring : "KikkerX");
      copyStringOrNull(srcAP, treeAP, "password");
    } else {
      // Absent or wrong type — default to KikkerX with RANDOM password.
      cJSON_AddStringToObject(treeAP, "ssid", "KikkerX");
      cJSON_AddStringToObject(treeAP, "password", AP_FALLBACK_RANDOM_TOKEN);
    }
    cJSON_AddItemToObject(tree, "fallback_access_point", treeAP);
  }

  copyBoolOrDefault(src, tree, "allow_cors", true);

  cJSON* srcAuth = cJSON_GetObjectItemCaseSensitive(src, "auth");
  cJSON* srcAuthUser = cJSON_IsObject(srcAuth) ? cJSON_GetObjectItemCaseSensitive(srcAuth, "username") : nullptr;
  if (cJSON_IsString(srcAuthUser)) {
    cJSON* treeAuth = cJSON_CreateObject();
    cJSON_AddStringToObject(treeAuth, "username", srcAuthUser->valuestring);
    cJSON* srcHash = cJSON_GetObjectItemCaseSensitive(srcAuth, "password_sha256");
    if (cJSON_IsString(srcHash) && srcHash->valuestring[0]) {
      cJSON_AddStringToObject(treeAuth, "password_sha256", srcHash->valuestring);
    } else {
      cJSON_AddNullToObject(treeAuth, "password_sha256");
    }
    cJSON_AddItemToObject(tree, "auth", treeAuth);
  } else {
    cJSON_AddNullToObject(tree, "auth");
  }

  copyBoolOrDefault(src, tree, "allow_ota", true);

  // src is owned by fromJSON — not freed here.

  // --- 2. Read fields into Config, redact passwords in the tree in the same pass ---

  cJSON* mdnsNode = cJSON_GetObjectItemCaseSensitive(tree, "mdns");
  if (cJSON_IsString(mdnsNode)) {
    mdns = mdnsNode->valuestring;
  }

  cJSON* net;
  cJSON_ArrayForEach(net, treeNets) {
    cJSON* pass = cJSON_GetObjectItemCaseSensitive(net, "password");
    WifiEntry e;
    e.ssid = cJSON_GetObjectItemCaseSensitive(net, "ssid")->valuestring;
    // pass is either a real string (redact for the API view) or null (open network — leave as-is).
    if (cJSON_IsString(pass)) {
      e.password = pass->valuestring;
      cJSON_SetValuestring(pass, "***");
    }
    cJSON* ip = cJSON_GetObjectItemCaseSensitive(net, "static_ip");
    if (cJSON_IsString(ip)) {
      e.static_ip = ip->valuestring;
      e.subnet_mask = cJSON_GetObjectItemCaseSensitive(net, "subnet_mask")->valuestring;
      e.gateway = cJSON_GetObjectItemCaseSensitive(net, "gateway")->valuestring;
      e.dns = cJSON_GetObjectItemCaseSensitive(net, "dns")->valuestring;
    }
    if (log) {
      Log.printf("config: wifi %s ip=%s\n", e.ssid.c_str(), e.static_ip.empty() ? "DHCP" : e.static_ip.c_str());
    }
    wifi_entries.push_back(std::move(e));
  }

  cJSON* apNode = cJSON_GetObjectItemCaseSensitive(tree, "fallback_access_point");
  if (cJSON_IsObject(apNode)) {
    ap_fallback.ssid = cJSON_GetObjectItemCaseSensitive(apNode, "ssid")->valuestring;
    cJSON* pass = cJSON_GetObjectItemCaseSensitive(apNode, "password");
    if (cJSON_IsString(pass) && strcmp(pass->valuestring, AP_FALLBACK_RANDOM_TOKEN) == 0) {
      // Keep the placeholder verbatim — wifi_connect's startAP generates the actual
      // password the first time the AP is brought up. Tree's "RANDOM" stays visible
      // in redactedJSON.
      ap_fallback.password = AP_FALLBACK_RANDOM_TOKEN;
      if (log) {
        Log.printf("config: AP fallback SSID=%s (auto-generated password)\n", ap_fallback.ssid.c_str());
      }
    } else if (cJSON_IsString(pass)) {
      ap_fallback.password = pass->valuestring;
      if (log) {
        Log.printf("config: AP fallback SSID=%s (password set)\n", ap_fallback.ssid.c_str());
      }
      cJSON_SetValuestring(pass, "***");
    } else if (log) {
      Log.printf("config: AP fallback SSID=%s (open)\n", ap_fallback.ssid.c_str());
    }
  }
  // If false: ap_fallback.ssid stays empty = not configured.

  allow_cors = cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(tree, "allow_cors"));

  cJSON* authNode = cJSON_GetObjectItemCaseSensitive(tree, "auth");
  if (cJSON_IsObject(authNode)) {
    auth.username = cJSON_GetObjectItemCaseSensitive(authNode, "username")->valuestring;
    cJSON* p = cJSON_GetObjectItemCaseSensitive(authNode, "password_sha256");
    if (cJSON_IsString(p)) {
      auth.password_sha256 = p->valuestring;
      char truncated[16];
      snprintf(truncated, sizeof(truncated), "%.6s***", p->valuestring);
      cJSON_SetValuestring(p, truncated);
    } else {
      Log.println("config: ERROR: auth.username set but auth.password_sha256 missing — all requests will be denied");
    }
  }

  allow_ota = cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(tree, "allow_ota"));

  // --- 3. Stringify ---

  char* s = cJSON_PrintUnformatted(tree);
  if (s) {
    redactedJSON = s;
    free(s);
  }
  cJSON_Delete(tree);
}

// ---------------------------------------------------------------------------
// Cached accessors
// ---------------------------------------------------------------------------

static ConfigInfo s_embedded;
static bool s_embedded_resolved = false;

static ConfigInfo s_stored;
static bool s_stored_resolved = false;

static ConfigInfo s_defaults;
static bool s_defaults_resolved = false;

// Snapshot of the config that was picked at boot — owned independently so
// stored-config edits (PATCH/PUT/DELETE) don't mutate what's actually running.
static ConfigInfo s_active;

static void snapshotActive(const Config& src, uint16_t version) {
  if (s_active.config) {
    return;  // first call wins; re-entries during re-dispatches are no-ops
  }
  s_active.config = unique_ptr<Config>(new Config(src));
  s_active.schema_version = version;
  s_active.is_active = true;
}

const ConfigInfo& getActiveConfigInfo() {
  // Ensure snapshot exists — getActiveConfig populates it as a side effect.
  getActiveConfig();
  return s_active;
}

const ConfigInfo& getFirmwareDefaults(bool log) {
  if (!s_defaults_resolved) {
    s_defaults_resolved = true;
    s_defaults.schema_version = CONFIG_SCHEMA_VERSION;
    s_defaults.config = Config::fromJSON("{}", log);
  }
  return s_defaults;
}

[[noreturn]] static void shutdownWithFatalError(const char* msg) {
  Log.println(msg);
  vTaskDelay(pdMS_TO_TICKS(3000));
  esp_deep_sleep_start();
  // esp_deep_sleep_start is noreturn; loop defensively.
  while (true) {
    vTaskDelay(pdMS_TO_TICKS(1000));
  }
}

const ConfigInfo& getEmbeddedConfig(bool log) {
  if (s_embedded_resolved) {
    return s_embedded;
  }
  s_embedded_resolved = true;

  if (CONFIG_POLICY >= CONFIG_POLICY_LOAD_OR_USE_DEFAULT) {
    // Embedded config is not used by LOAD_OR_USE_DEFAULT or LOAD_OR_FAIL.
    return s_embedded;
  }

  char* buf = embeddedJsonBuf();
  if (buf) {
    s_embedded.config = Config::fromJSON(buf, log);
    if (s_embedded.config) {
      s_embedded.schema_version = CONFIG_SCHEMA_VERSION;
    }
    free(buf);
  }
  return s_embedded;
}

const ConfigInfo& getStoredConfig(bool log) {
  if (s_stored_resolved) {
    return s_stored;
  }
  s_stored_resolved = true;

  uint16_t ver = 0;
  if (!nvsReadVersion(&ver)) {
    return s_stored;
  }
  s_stored.schema_version = ver;

  if (ver != CONFIG_SCHEMA_VERSION) {
    Log.printf("config: NVS schema version %u, expected %u\n", ver, CONFIG_SCHEMA_VERSION);
    return s_stored;
  }

  char* buf = nvsLoadJSON();
  if (buf) {
    s_stored.config = Config::fromJSON(buf, log);
    free(buf);
  }
  return s_stored;
}

// ---------------------------------------------------------------------------
// getActiveConfig — policy dispatcher
// ---------------------------------------------------------------------------

// Each getter is called here with log=true — on first call (boot), that gets
// forwarded to fromJSON so only the actually-picked source logs its contents.
// Repeat calls from other code paths (e.g. /api/config inspection) find the
// cache already populated and the flag is ignored.

const Config& getActiveConfig() {
  // Fast path after the snapshot is built. Returning the snapshot (not a source
  // cache) is what makes the long-lived references and pointers callers hold into
  // the returned Config stable across stored-config edits.
  if (s_active.config) {
    return *s_active.config;
  }

  // Try stored config for policies that load from NVS.
  if (CONFIG_POLICY >= CONFIG_POLICY_LOAD_OR_USE_EMBEDDED) {
    const ConfigInfo& stored = getStoredConfig(true);
    if (stored.config) {
      s_active_source = "stored";
      s_stored.is_active = true;
      snapshotActive(*stored.config, stored.schema_version);
      return *s_active.config;
    }
  }

  // No usable stored config.
  if (CONFIG_POLICY == CONFIG_POLICY_LOAD_OR_USE_DEFAULT) {
    s_active_source = "default";
    const ConfigInfo& defaults = getFirmwareDefaults(true);
    s_defaults.is_active = true;
    snapshotActive(*defaults.config, defaults.schema_version);
    return *s_active.config;
  }

  if (CONFIG_POLICY == CONFIG_POLICY_LOAD_OR_FAIL) {
    shutdownWithFatalError("config: no valid config in NVS — shutting down");
  }

  // NVS save side effects (one-time). If we write to NVS, stored is kept in
  // sync with embedded and counts as active even though not read this boot.
  static bool s_nvs_saved = false;
  if (!s_nvs_saved) {
    s_nvs_saved = true;
    if (CONFIG_POLICY == CONFIG_POLICY_STORE_EMBEDDED || CONFIG_POLICY == CONFIG_POLICY_LOAD_OR_STORE_EMBEDDED) {
      char* buf = embeddedJsonBuf();
      if (buf) {
        nvsSave(buf);
        free(buf);
        s_stored.is_active = true;
      }
    }
  }

  const ConfigInfo& embedded = getEmbeddedConfig(true);
  if (embedded.config) {
    s_active_source = "embedded";
    s_embedded.is_active = true;
    snapshotActive(*embedded.config, embedded.schema_version);
    return *s_active.config;
  }

  shutdownWithFatalError("config: embedded config failed to parse — shutting down");
}

const char* getConfigActiveSource() {
  return s_active_source;
}

const char* getConfigPolicyName() {
  static const char* names[] = {
      "USE_EMBEDDED",
      "STORE_EMBEDDED",
      "LOAD_OR_USE_EMBEDDED",
      "LOAD_OR_STORE_EMBEDDED",
      "LOAD_OR_USE_DEFAULT",
      "LOAD_OR_FAIL",
  };
  if (CONFIG_POLICY >= 0 && CONFIG_POLICY < (int)(sizeof(names) / sizeof(names[0]))) {
    return names[CONFIG_POLICY];
  }
  return "UNKNOWN";
}

// ---------------------------------------------------------------------------
// Stored-config editing (PATCH / DELETE / PUT known_networks)
// ---------------------------------------------------------------------------

bool canEditStoredConfig() {
  // Only LOAD_OR_* policies actually read NVS at runtime. For USE_EMBEDDED and
  // STORE_EMBEDDED the firmware would never consult the edited NVS entry, so
  // accepting the write would only confuse users.
  return CONFIG_POLICY >= CONFIG_POLICY_LOAD_OR_USE_EMBEDDED;
}

// Loads the current NVS JSON as a cJSON object. On absence / bad schema /
// parse failure returns an empty object — the caller can then patch onto it
// and the result becomes the new stored config (creation case).
static cJSON* loadStoredAsJson() {
  char* buf = nvsLoadJSON();
  cJSON* obj = nullptr;
  if (buf) {
    obj = cJSON_Parse(buf);
    free(buf);
  }
  if (!cJSON_IsObject(obj)) {
    if (obj) {
      cJSON_Delete(obj);
    }
    obj = cJSON_CreateObject();
  }
  return obj;
}

// RFC 7396 JSON Merge Patch: objects are deep-merged, null keys removed,
// everything else (arrays, primitives, new objects) replaces in place.
static void mergePatch(cJSON* target, const cJSON* patch) {
  if (!cJSON_IsObject(target) || !cJSON_IsObject(patch)) {
    return;
  }
  const cJSON* item;
  cJSON_ArrayForEach(item, patch) {
    const char* key = item->string;
    if (cJSON_IsNull(item)) {
      cJSON_DeleteItemFromObjectCaseSensitive(target, key);
      continue;
    }
    if (cJSON_IsObject(item)) {
      cJSON* existing = cJSON_GetObjectItemCaseSensitive(target, key);
      if (cJSON_IsObject(existing)) {
        mergePatch(existing, item);
        continue;
      }
    }
    // Arrays, primitives, or object-replacing-non-object — replace wholesale.
    cJSON_DeleteItemFromObjectCaseSensitive(target, key);
    cJSON_AddItemToObject(target, key, cJSON_Duplicate(item, 1));
  }
}

// Validates via Config::fromJSON, then writes the merged JSON verbatim to NVS. Any
// unknown keys in the input survive but fromJSON tolerates them on the next read.
// On failure returns a human-readable error; NVS and s_stored stay untouched.
static string commitStoredUpdate(cJSON* updated) {
  char* merged = cJSON_PrintUnformatted(updated);
  if (!merged) {
    return "out of memory serializing config";
  }
  unique_ptr<Config> validated = Config::fromJSON(merged);
  if (!validated) {
    free(merged);
    return "merged config failed to parse as a valid config";
  }
  nvsSave(merged);
  free(merged);
  s_stored.config = std::move(validated);
  s_stored.schema_version = CONFIG_SCHEMA_VERSION;
  s_stored.is_modified = true;
  // After an edit, NVS no longer matches what's running; the source isn't "active" anymore.
  s_stored.is_active = false;
  s_stored_resolved = true;  // ensure future getStoredConfig() calls see the edit, not a lazy re-parse
  return "";
}

string patchStoredConfig(const char* patchJson) {
  cJSON* patch = cJSON_Parse(patchJson);
  if (!patch) {
    return "invalid JSON in request body";
  }
  if (!cJSON_IsObject(patch)) {
    cJSON_Delete(patch);
    return "request body must be a JSON object";
  }
  cJSON* merged = loadStoredAsJson();
  mergePatch(merged, patch);
  cJSON_Delete(patch);
  // Promote auth.password (cleartext, sent by the UI because crypto.subtle is
  // unavailable on plain HTTP) to auth.password_sha256 before persisting.
  cJSON* mergedAuth = cJSON_GetObjectItemCaseSensitive(merged, "auth");
  if (cJSON_IsObject(mergedAuth)) {
    cJSON* clearPwd = cJSON_GetObjectItemCaseSensitive(mergedAuth, "password");
    if (cJSON_IsString(clearPwd) && clearPwd->valuestring[0]) {
      string hash = sha256Hex(clearPwd->valuestring, strlen(clearPwd->valuestring));
      cJSON_DeleteItemFromObjectCaseSensitive(mergedAuth, "password");
      cJSON_DeleteItemFromObjectCaseSensitive(mergedAuth, "password_sha256");
      cJSON_AddStringToObject(mergedAuth, "password_sha256", hash.c_str());
    }
  }
  string err = commitStoredUpdate(merged);
  cJSON_Delete(merged);
  return err;
}

string deleteStoredConfig() {
  nvs_handle_t h;
  if (nvs_open(NVS_NS, NVS_READWRITE, &h) == ESP_OK) {
    nvs_erase_key(h, NVS_KEY_SCHEMA_VERSION);
    nvs_erase_key(h, NVS_KEY_JSON);
    nvs_commit(h);
    nvs_close(h);
  }
  s_stored.config.reset();
  s_stored.schema_version = 0;
  s_stored.is_modified = true;
  s_stored.is_active = false;
  s_stored_resolved = true;
  return "";
}

string copyStoredFrom(const char* source) {
  if (!source) {
    return "missing source";
  }
  // Sources own their JSON: embedded comes from the INCBIN'd build-time blob,
  // default is just "{}". Active is intentionally not a copy source — it can't be
  // edited on its own, and "freezing the running snapshot" has no real use case.
  string sourceJson;
  if (strcmp(source, "embedded") == 0) {
    char* buf = embeddedJsonBuf();
    if (!buf) {
      return "embedded config is not available";
    }
    sourceJson = buf;
    free(buf);
  } else if (strcmp(source, "default") == 0) {
    sourceJson = "{}";
  } else {
    return "source must be 'embedded' or 'default'";
  }
  unique_ptr<Config> validated = Config::fromJSON(sourceJson.c_str());
  if (!validated) {
    return "source config failed to parse";
  }
  nvsSave(sourceJson.c_str());
  s_stored.config = std::move(validated);
  s_stored.schema_version = CONFIG_SCHEMA_VERSION;
  s_stored.is_modified = true;
  s_stored.is_active = false;
  s_stored_resolved = true;
  return "";
}

string putKnownNetwork(const char* entryJson) {
  cJSON* entry = cJSON_Parse(entryJson);
  if (!entry || !cJSON_IsObject(entry)) {
    if (entry) {
      cJSON_Delete(entry);
    }
    return "request body must be a JSON object";
  }
  cJSON* ssid = cJSON_GetObjectItemCaseSensitive(entry, "ssid");
  if (!cJSON_IsString(ssid) || !ssid->valuestring[0]) {
    cJSON_Delete(entry);
    return "entry must have a non-empty ssid";
  }
  cJSON* merged = loadStoredAsJson();
  cJSON* networks = cJSON_GetObjectItemCaseSensitive(merged, "known_networks");
  if (!cJSON_IsArray(networks)) {
    cJSON_DeleteItemFromObjectCaseSensitive(merged, "known_networks");
    networks = cJSON_AddArrayToObject(merged, "known_networks");
  }
  // Replace by SSID if already present; otherwise append.
  bool replaced = false;
  int count = cJSON_GetArraySize(networks);
  for (int i = 0; i < count; i++) {
    cJSON* existing = cJSON_GetArrayItem(networks, i);
    cJSON* existingSsid = cJSON_GetObjectItemCaseSensitive(existing, "ssid");
    if (cJSON_IsString(existingSsid) && strcmp(existingSsid->valuestring, ssid->valuestring) == 0) {
      cJSON_ReplaceItemInArray(networks, i, cJSON_Duplicate(entry, 1));
      replaced = true;
      break;
    }
  }
  if (!replaced) {
    cJSON_AddItemToArray(networks, cJSON_Duplicate(entry, 1));
  }
  cJSON_Delete(entry);
  string err = commitStoredUpdate(merged);
  cJSON_Delete(merged);
  return err;
}

string deleteKnownNetwork(const char* ssid) {
  if (!ssid || !ssid[0]) {
    return "missing ssid";
  }
  cJSON* merged = loadStoredAsJson();
  cJSON* networks = cJSON_GetObjectItemCaseSensitive(merged, "known_networks");
  if (cJSON_IsArray(networks)) {
    int count = cJSON_GetArraySize(networks);
    for (int i = 0; i < count; i++) {
      cJSON* existing = cJSON_GetArrayItem(networks, i);
      cJSON* existingSsid = cJSON_GetObjectItemCaseSensitive(existing, "ssid");
      if (cJSON_IsString(existingSsid) && strcmp(existingSsid->valuestring, ssid) == 0) {
        cJSON_DeleteItemFromArray(networks, i);
        break;
      }
    }
  }
  // commit unconditionally so the user always sees is_modified on a deletion request,
  // even if no entry actually matched (idempotent: no error either way).
  string err = commitStoredUpdate(merged);
  cJSON_Delete(merged);
  return err;
}
