#include "wifi_connect.h"

#include <WiFi.h>

#include "config.h"
#include "log.h"

static const int CONNECT_TIMEOUT_S = 20;
static const int RETRY_DELAY_S = 10;
// How many failed scan cycles before falling back to AP (when configured).
static const int MAX_CONNECT_ATTEMPTS = 3;
static const unsigned long ROAM_INTERVAL_MS = 5UL * 60 * 1000;
// Switch networks only if the candidate is this much stronger than the current.
static const int ROAM_THRESHOLD_DBM = 15;
// How often to scan for known networks while in AP mode.
static const unsigned long AP_SCAN_INTERVAL_MS = 5UL * 60 * 1000;

static const WifiEntry* g_current = nullptr;
static bool g_apMode = false;

bool wifiIsAP() {
  return g_apMode;
}

static void applyIpConfig(const WifiEntry* e) {
  if (!e->static_ip.empty()) {
    IPAddress ip, gw, sn, dns;
    ip.fromString(e->static_ip.c_str());
    sn.fromString(e->subnet_mask.c_str());
    gw.fromString(e->gateway.c_str());
    dns.fromString(e->dns.c_str());
    WiFi.config(ip, gw, sn, dns);
    Log.printf("Static IP: %s\n", e->static_ip.c_str());
  } else {
    WiFi.config(INADDR_NONE, INADDR_NONE, INADDR_NONE);
  }
}

// Try once to connect to e. Returns true on success.
static bool connectTo(const WifiEntry* e, int scanRssi) {
  Log.printf("Connecting to %s (RSSI %d)...\n", e->ssid.c_str(), scanRssi);
  WiFi.disconnect();
  delay(100);
  applyIpConfig(e);
  WiFi.begin(e->ssid.c_str(), e->password.c_str());
  WiFi.setSleep(false);
  for (int t = 0; t < CONNECT_TIMEOUT_S * 2; t++) {
    if (WiFi.status() == WL_CONNECTED) {
      WiFi.setTxPower(WIFI_POWER_19_5dBm);
      g_current = e;
      Log.printf("Connected: %s  IP: %s  RSSI: %d\n", e->ssid.c_str(), WiFi.localIP().toString().c_str(), WiFi.RSSI());
      return true;
    }
    delay(500);
  }
  Log.printf("Timeout connecting to %s\n", e->ssid.c_str());
  return false;
}

// Blocking scan. Returns the strongest known network and sets *rssi,
// or nullptr if no known network is visible.
static const WifiEntry* scanPick(int* rssi) {
  Log.println("Scanning WiFi...");
  int found = WiFi.scanNetworks();
  const WifiEntry* chosen = nullptr;
  *rssi = -9999;
  if (found > 0) {
    const Config& cfg = getActiveConfig();
    for (int s = 0; s < found; s++) {
      String sid = WiFi.SSID(s);
      int r = WiFi.RSSI(s);
      for (const auto& e : cfg.wifi_entries) {
        if (sid == e.ssid.c_str() && r > *rssi) {
          *rssi = r;
          chosen = &e;
        }
      }
    }
  }
  WiFi.scanDelete();
  return chosen;
}

static void startAP(const ApFallback& ap) {
  WiFi.mode(WIFI_AP);
  bool ok = ap.password.empty() ? WiFi.softAP(ap.ssid.c_str()) : WiFi.softAP(ap.ssid.c_str(), ap.password.c_str());
  if (ok) {
    g_apMode = true;
    g_current = nullptr;
    Log.printf("AP mode: SSID=%s  IP=%s\n", ap.ssid.c_str(), WiFi.softAPIP().toString().c_str());
  } else {
    Log.println("AP start failed");
  }
}

void wifiConnect() {
  g_apMode = false;
  if (WiFi.getMode() & WIFI_MODE_AP)
    WiFi.softAPdisconnect(true);

  const Config& cfg = getActiveConfig();
  bool hasAP = !cfg.ap_fallback.ssid.empty();
  if (cfg.wifi_entries.empty()) {
    if (hasAP) {
      Log.println("No WiFi networks configured — starting AP");
      startAP(cfg.ap_fallback);
    } else {
      Log.println("No WiFi networks configured and no AP fallback");
    }
    return;
  }

  WiFi.mode(WIFI_STA);

  for (int attempt = 0;; attempt++) {
    int rssi;
    const WifiEntry* e = scanPick(&rssi);
    if (e && connectTo(e, rssi))
      return;

    if (attempt + 1 >= MAX_CONNECT_ATTEMPTS && hasAP) {
      Log.printf("No known network found after %d attempts — starting AP\n", MAX_CONNECT_ATTEMPTS);
      startAP(cfg.ap_fallback);
      return;
    }
    Log.printf("No known network found, retrying in %ds...\n", RETRY_DELAY_S);
    delay(RETRY_DELAY_S * 1000);
  }
}

bool wifiMaintain() {
  if (g_apMode) {
    // Periodically scan for known networks. Use AP_STA mode so the AP stays
    // alive during the scan, then drop back to pure AP if nothing is found.
    static unsigned long lastApScanMs = 0;
    unsigned long now = millis();
    if (now - lastApScanMs < AP_SCAN_INTERVAL_MS)
      return false;
    lastApScanMs = now;

    if (getActiveConfig().wifi_entries.empty()) {
      return false;
    }

    WiFi.mode(WIFI_AP_STA);
    int found = WiFi.scanNetworks();  // blocking
    bool knownVisible = false;
    if (found > 0) {
      const auto& entries = getActiveConfig().wifi_entries;
      for (int s = 0; s < found && !knownVisible; s++) {
        String sid = WiFi.SSID(s);
        for (const auto& e : entries) {
          if (sid == e.ssid.c_str()) {
            knownVisible = true;
            break;
          }
        }
      }
    }
    WiFi.scanDelete();

    if (!knownVisible) {
      WiFi.mode(WIFI_AP);  // restore pure AP
      return false;
    }

    Log.println("Known network visible — leaving AP mode");
    wifiConnect();
    return !g_apMode;  // true only if we successfully connected to STA
  }

  static unsigned long lastRoamMs = 0;
  static bool scanPending = false;
  unsigned long now = millis();

  if (WiFi.status() != WL_CONNECTED) {
    Log.println("WiFi lost, reconnecting...");
    scanPending = false;
    wifiConnect();
    lastRoamMs = millis();
    return true;
  }

  // Kick off an async scan periodically (does not disconnect).
  if (!scanPending && now - lastRoamMs >= ROAM_INTERVAL_MS) {
    WiFi.scanNetworks(/*async=*/true);
    scanPending = true;
  }

  if (!scanPending)
    return false;

  int n = WiFi.scanComplete();
  if (n == WIFI_SCAN_RUNNING)
    return false;
  scanPending = false;
  lastRoamMs = now;

  if (n <= 0) {
    WiFi.scanDelete();
    return false;
  }

  int curRssi = WiFi.RSSI();
  const WifiEntry* bestEntry = nullptr;
  int bestRssi = curRssi + ROAM_THRESHOLD_DBM;
  const Config& cfg = getActiveConfig();
  for (int s = 0; s < n; s++) {
    String sid = WiFi.SSID(s);
    int r = WiFi.RSSI(s);
    if (g_current && sid == g_current->ssid.c_str())
      continue;
    for (const auto& e : cfg.wifi_entries) {
      if (sid == e.ssid.c_str() && r > bestRssi) {
        bestRssi = r;
        bestEntry = &e;
      }
    }
  }
  WiFi.scanDelete();

  if (!bestEntry)
    return false;

  Log.printf("Roaming to %s (%d dBm, current %d dBm)\n", bestEntry->ssid.c_str(), bestRssi, curRssi);
  if (!connectTo(bestEntry, bestRssi))
    wifiConnect();
  lastRoamMs = millis();
  return true;
}
