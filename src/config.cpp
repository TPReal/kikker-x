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

#include "log.h"

INCBIN(config_json, "src/_config.json");

static const int MAX_WIFI_ENTRIES = 10;

// Module-level storage — kept alive so char* fields in Config remain valid.
static cJSON* s_root = nullptr;
static Config s_config = {};
static WifiEntry s_wifi_entries[MAX_WIFI_ENTRIES];
static ApFallback s_ap = {};
static bool s_parsed = false;
static char s_ap_random_password[13];

// ---------------------------------------------------------------------------
// NVS persistence — stores the config JSON alongside CONFIG_VERSION.
// ---------------------------------------------------------------------------

static const char* NVS_NS = "config";
static const char* NVS_KEY_VER = "version";
static const char* NVS_KEY_JSON = "json";

// Returns a malloc'd null-terminated JSON string, or nullptr if unavailable / wrong version.
static char* nvsLoad() {
  nvs_handle_t h;
  if (nvs_open(NVS_NS, NVS_READONLY, &h) != ESP_OK) {
    Log.println("config: NVS open failed");
    return nullptr;
  }
  uint16_t ver = 0;
  nvs_get_u16(h, NVS_KEY_VER, &ver);
  if (ver != CONFIG_VERSION) {
    Log.printf("config: NVS version %u, expected %u — ignoring stored config\n", ver, CONFIG_VERSION);
    nvs_close(h);
    return nullptr;
  }
  size_t len = 0;
  if (nvs_get_str(h, NVS_KEY_JSON, nullptr, &len) != ESP_OK || len == 0) {
    Log.println("config: NVS key missing or empty");
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
  nvs_set_u16(h, NVS_KEY_VER, CONFIG_VERSION);
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

Config getConfig() {
  if (s_parsed) {
    return s_config;
  }
  s_parsed = true;

  // Step 1: Obtain the JSON string according to the active policy.
  char* buf = nullptr;
  bool from_nvs = false;

  if (CONFIG_POLICY >= CONFIG_POLICY_LOAD_OR_USE_EMBEDDED) {
    buf = nvsLoad();
    if (buf) {
      from_nvs = true;
      Log.println("config: loaded from NVS");
    }
  }

  if (!buf) {
    if (CONFIG_POLICY == CONFIG_POLICY_LOAD_OR_FAIL) {
      Log.println("config: no valid config in NVS — shutting down");
      vTaskDelay(pdMS_TO_TICKS(3000));
      esp_deep_sleep_start();
      return s_config;
    }
    buf = embeddedJsonBuf();
    if (!buf) {
      Log.println("config: alloc failed");
      return s_config;
    }
  }

  // Step 2: Store to NVS if the policy requires it and we didn't just load from there.
  if (!from_nvs &&
      (CONFIG_POLICY == CONFIG_POLICY_STORE_EMBEDDED || CONFIG_POLICY == CONFIG_POLICY_LOAD_OR_STORE_EMBEDDED)) {
    nvsSave(buf);
  }

  // Step 3: Parse.
  s_root = cJSON_Parse(buf);
  free(buf);

  if (!s_root) {
    Log.println("config: JSON parse failed");
    return s_config;
  }

  cJSON* mdns = cJSON_GetObjectItemCaseSensitive(s_root, "mdns");
  if (cJSON_IsString(mdns))
    s_config.mdns = mdns->valuestring;

  cJSON* networks = cJSON_GetObjectItemCaseSensitive(s_root, "known_networks");
  if (cJSON_IsArray(networks)) {
    cJSON* item;
    cJSON_ArrayForEach(item, networks) {
      if (s_config.num_wifi_entries >= MAX_WIFI_ENTRIES)
        break;
      cJSON* ssid = cJSON_GetObjectItemCaseSensitive(item, "ssid");
      cJSON* pass = cJSON_GetObjectItemCaseSensitive(item, "password");
      if (!cJSON_IsString(ssid) || !cJSON_IsString(pass))
        continue;
      WifiEntry& e = s_wifi_entries[s_config.num_wifi_entries++];
      e.ssid = ssid->valuestring;
      e.password = pass->valuestring;
      cJSON* ip = cJSON_GetObjectItemCaseSensitive(item, "static_ip");
      cJSON* sn = cJSON_GetObjectItemCaseSensitive(item, "subnet_mask");
      cJSON* gw = cJSON_GetObjectItemCaseSensitive(item, "gateway");
      cJSON* dns = cJSON_GetObjectItemCaseSensitive(item, "dns");
      e.static_ip = cJSON_IsString(ip) ? ip->valuestring : nullptr;
      e.subnet_mask = cJSON_IsString(sn) ? sn->valuestring : nullptr;
      e.gateway = cJSON_IsString(gw) ? gw->valuestring : nullptr;
      e.dns = cJSON_IsString(dns) ? dns->valuestring : nullptr;
      Log.printf("config: wifi %s ip=%s\n", e.ssid, e.static_ip ? e.static_ip : "DHCP");
    }
  }
  s_config.wifi_entries = s_wifi_entries;

  auto generateRandomPassword = []() {
    static const char kChars[] = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
    for (int i = 0; i < 12; i++) {
      s_ap_random_password[i] = kChars[esp_random() % 55];
    }
    s_ap_random_password[12] = '\0';
  };

  cJSON* apNode = cJSON_GetObjectItemCaseSensitive(s_root, "fallback_access_point");
  if (cJSON_IsFalse(apNode)) {
    // Explicitly disabled: "fallback_access_point": false
  } else if (cJSON_IsObject(apNode)) {
    cJSON* ssid = cJSON_GetObjectItemCaseSensitive(apNode, "ssid");
    cJSON* pass = cJSON_GetObjectItemCaseSensitive(apNode, "password");
    if (cJSON_IsString(ssid)) {
      s_ap.ssid = ssid->valuestring;
      if (cJSON_IsString(pass) && strcmp(pass->valuestring, "RANDOM") == 0) {
        generateRandomPassword();
        s_ap.password = s_ap_random_password;
        Log.printf("config: AP fallback SSID=%s  password: %s\n", s_ap.ssid, s_ap.password);
      } else {
        s_ap.password = cJSON_IsString(pass) ? pass->valuestring : nullptr;
        Log.printf("config: AP fallback SSID=%s %s\n", s_ap.ssid, s_ap.password ? "(password set)" : "(open)");
      }
      s_config.ap_fallback = &s_ap;
    }
  } else {
    // Key absent or unrecognized — use default AP with random password.
    s_ap.ssid = "KikkerX";
    generateRandomPassword();
    s_ap.password = s_ap_random_password;
    s_config.ap_fallback = &s_ap;
    Log.printf("config: AP fallback SSID=%s  password: %s (default)\n", s_ap.ssid, s_ap.password);
  }

  s_config.allow_cors = true;
  cJSON* allowCors = cJSON_GetObjectItemCaseSensitive(s_root, "allow_cors");
  if (cJSON_IsBool(allowCors))
    s_config.allow_cors = cJSON_IsTrue(allowCors);

  cJSON* auth = cJSON_GetObjectItemCaseSensitive(s_root, "auth");
  if (cJSON_IsObject(auth)) {
    cJSON* u = cJSON_GetObjectItemCaseSensitive(auth, "username");
    cJSON* p = cJSON_GetObjectItemCaseSensitive(auth, "password_sha256");
    if (cJSON_IsString(u))
      s_config.auth.username = u->valuestring;
    if (cJSON_IsString(p))
      s_config.auth.password_sha256 = p->valuestring;
    if (s_config.auth.username && !s_config.auth.password_sha256)
      Log.println("config: ERROR: auth.username set but auth.password_sha256 missing — all requests will be denied");
  }

  s_config.allow_ota = true;
  cJSON* allowOta = cJSON_GetObjectItemCaseSensitive(s_root, "allow_ota");
  if (cJSON_IsBool(allowOta))
    s_config.allow_ota = cJSON_IsTrue(allowOta);

  Log.printf("config: mdns=%s cors=%s auth=%s ota=%s policy=%s\n", s_config.mdns ? s_config.mdns : "(none)",
      s_config.allow_cors ? "on" : "off", s_config.auth.username ? s_config.auth.username : "(none)",
      s_config.allow_ota ? "on" : "off", getConfigPolicyName());
  return s_config;
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
