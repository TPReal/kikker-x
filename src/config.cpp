// INCBIN must be configured before incbin.h is included.
#define INCBIN_PREFIX
#define INCBIN_STYLE INCBIN_STYLE_SNAKE
#include "config.h"

#include <cJSON.h>
#include <esp_random.h>
#include <incbin.h>
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

Config getConfig() {
  if (s_parsed)
    return s_config;
  s_parsed = true;

  char* buf = (char*)malloc(config_json_size + 1);
  if (!buf) {
    Log.println("config: alloc failed");
    return s_config;
  }
  memcpy(buf, config_json_data, config_json_size);
  buf[config_json_size] = '\0';

  s_root = cJSON_Parse(buf);
  free(buf);

  if (!s_root) {
    Log.println("config: JSON parse failed");
    return s_config;
  }

  cJSON* mdns = cJSON_GetObjectItemCaseSensitive(s_root, "mdns");
  if (cJSON_IsString(mdns))
    s_config.mdns = mdns->valuestring;

  cJSON* auth = cJSON_GetObjectItemCaseSensitive(s_root, "auth");
  if (cJSON_IsObject(auth)) {
    cJSON* u = cJSON_GetObjectItemCaseSensitive(auth, "username");
    cJSON* p = cJSON_GetObjectItemCaseSensitive(auth, "pass_sha256");
    if (cJSON_IsString(u))
      s_config.auth.username = u->valuestring;
    if (cJSON_IsString(p))
      s_config.auth.pass_sha256 = p->valuestring;
    if (s_config.auth.username && !s_config.auth.pass_sha256)
      Log.println("config: ERROR: auth.username set but auth.pass_sha256 missing — all requests will be denied");
  }

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

  cJSON* apNode = cJSON_GetObjectItemCaseSensitive(s_root, "fallback_access_point");
  if (cJSON_IsObject(apNode)) {
    cJSON* ssid = cJSON_GetObjectItemCaseSensitive(apNode, "ssid");
    cJSON* pass = cJSON_GetObjectItemCaseSensitive(apNode, "password");
    if (cJSON_IsString(ssid)) {
      s_ap.ssid = ssid->valuestring;
      if (cJSON_IsString(pass) && strcmp(pass->valuestring, "RANDOM") == 0) {
        static const char kChars[] = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
        for (int i = 0; i < 12; i++)
          s_ap_random_password[i] = kChars[esp_random() % 55];
        s_ap_random_password[12] = '\0';
        s_ap.password = s_ap_random_password;
        Log.printf("config: AP fallback SSID=%s  password: %s\n", s_ap.ssid, s_ap.password);
      } else {
        s_ap.password = cJSON_IsString(pass) ? pass->valuestring : nullptr;
        Log.printf("config: AP fallback SSID=%s %s\n", s_ap.ssid, s_ap.password ? "(password set)" : "(open)");
      }
      s_config.ap_fallback = &s_ap;
    }
  }

  Log.printf("config: mdns=%s auth=%s\n", s_config.mdns ? s_config.mdns : "(none)",
      s_config.auth.username ? s_config.auth.username : "(none)");
  return s_config;
}
