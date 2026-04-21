/**
 * kikker.ino — MJPEG camera server for ESP32 camera boards
 *
 * Static files (served from catalog):
 *   GET /                → index.html  (home page: battery, power-off, links)
 *   GET /video           → video.html  (live MJPEG viewer)
 *   GET /photo           → photo.html  (still capture viewer)
 *   GET /settings.mjs    Shared settings panel JS
 *   GET /style.css       Shared stylesheet
 *
 * API endpoints:
 *   GET   /api/status                            → JSON {battery, id, wifi, version}
 *   GET   /api/config                            → JSON {policy, source, config, …}
 *   POST  /api/restart                           → reboot the ESP32
 *   GET   /api/firmware                            → download running firmware (if policy allows)
 *   POST  /api/firmware                           → stream firmware binary; reboots on success
 *   POST  /api/poweroff?duration=N               → power off or timed sleep
 *   POST  /api/wifi/reconnect                    → disconnect WiFi, wait 3 s, reconnect (may roam)
 *   GET   /api/led                               → JSON {state: bool}
 *   PATCH /api/led                               → body {state: bool}, returns same
 *   POST  /api/led/blink                         → body {pattern: "on,off,..."}, blinks then restores
 *   GET   /api/cam/stream.mjpeg?...              → raw MJPEG (FreeRTOS task)
 *   GET   /api/cam/capture.jpg?...               → raw still JPEG
 *   GET   /api/streamfps                         → JSON {fps, active}
 *   GET   /api/logs                              → plain-text log buffer
 *
 * WiFi credentials are in _config.json.
 */

#include <ESPmDNS.h>
#include <WiFi.h>
#include <cJSON.h>
#include <esp_camera.h>
#include <esp_image_format.h>
#include <esp_ota_ops.h>
#include <lwip/sockets.h>

#include <atomic>
#include <cstring>

#include "_version.h"
#include "auth.h"
#include "battery.h"
#include "board.h"
#include "config.h"
#include "log.h"
#include "static.h"
#include "wifi_connect.h"

// Marker placed in .rodata so we can identify our firmware version from the
// raw binary. Both the on-device OTA handler (VersionScanner) and the web UI
// scan the binary for "KIKKER_X_FW_VERSION=" and read the version string up
// to \0. The prefix must exist exactly once in the binary — otherwise the
// scanner could match a stray copy and read \0 (or garbage) as the version.
// To ensure that, no other place in the code uses "KIKKER_X_FW_VERSION=" as
// a string literal: VersionScanner::memcmp compares against this array, and
// MARKER_LEN is computed by kMarkerPrefixLen() which scans this array.
//
// `constexpr` is required so kMarkerPrefixLen() below can read this array in a
// constant expression under C++11 (Arduino core default). `used` keeps it in
// rodata even though nothing in the running program reads it.
//
// NOTE: esp_app_desc->version can't be used because in PlatformIO + Arduino
// the Arduino core is pre-built, so its esp_app_desc is baked in with the
// IDF's own git describe and our PROJECT_VER never reaches it.
__attribute__((used)) constexpr char KIKKER_X_FW_VERSION_MARKER[] = "KIKKER_X_FW_VERSION=" FIRMWARE_VERSION;

// Length of the "KIKKER_X_FW_VERSION=" prefix (through and including the '=').
// Computed by scanning the marker itself so no duplicate literal is emitted.
// Recursive form because C++11 constexpr functions must be a single return.
static constexpr size_t kMarkerPrefixLen(size_t n = 0) {
  return KIKKER_X_FW_VERSION_MARKER[n] == '=' ? n + 1 : kMarkerPrefixLen(n + 1);
}

// ---------------------------------------------------------------------------
// LED helper
// ---------------------------------------------------------------------------

static void blinkLed(int times) {
  if (!boardFeatures().led)
    return;
  for (int i = 0; i < times; i++) {
    if (i > 0)
      delay(100);
    boardSetLed(true);
    delay(100);
    boardSetLed(false);
  }
}

WiFiServer server(80, 6);  // backlog for simultaneous connections

// Current user-controlled LED state (blue LED on the board).
static bool g_ledState = false;

// mDNS hostname (set in setup(), re-registered on reconnect).
static String g_mdnsName;

// True while a stream task is running.
static volatile bool g_streamActive = false;
// Most-recently measured stream FPS (updated every 20 frames by the stream
// task).
static std::atomic<float> g_streamFps{0.0f};
// Set to true to ask the running stream to exit at the next frame boundary.
static volatile bool g_stopStream = false;
// Set to true by captureTask when a photo was taken with its own settings
// while a stream was active; the stream will re-apply its own settings on
// the next frame, then clear this flag.
static volatile bool g_settingsDirty = false;
// Set by loop() to ask the stream to pause at the next frame boundary.
// Cleared by captureTask once the photo is done.
static volatile bool g_streamPause = false;
// Set by the stream task to acknowledge it is paused and not holding any
// camera resources; cleared when the stream resumes.
static volatile bool g_streamPaused = false;
// True while a captureTask is running, so streamTask knows not to release
// the camera on exit.
static volatile bool g_captureActive = false;

// Signal the running stream (if any) to stop and block until it has exited.
// Safe to call from loop() — delay() inside yields to the FreeRTOS scheduler
// so the stream task can run, detect the flag, and clean up.
static void stopStream() {
  if (!g_streamActive)
    return;
  g_stopStream = true;
  // The stream may be stuck in sendBytes() for up to its 3 s stall timeout
  // before it can check g_stopStream and clean up.  Use 5 s here so the
  // stream always has time to exit and clear g_streamActive before we return.
  unsigned long deadline = millis() + 5000;
  while (g_streamActive && millis() < deadline)
    delay(10);
  g_stopStream = false;
}

// ---------------------------------------------------------------------------
// Resolution table — all resolutions supported by the OV3660 (max: UXGA
// 1600x1200)
// ---------------------------------------------------------------------------

struct ResEntry {
  const char* name;
  framesize_t size;
};

static const ResEntry RESOLUTIONS[] = {
    {"QQVGA", FRAMESIZE_QQVGA},  // 160x120
    {"QVGA", FRAMESIZE_QVGA},  // 320x240
    {"CIF", FRAMESIZE_CIF},  // 400x296
    {"VGA", FRAMESIZE_VGA},  // 640x480
    {"SVGA", FRAMESIZE_SVGA},  // 800x600
    {"XGA", FRAMESIZE_XGA},  // 1024x768
    {"SXGA", FRAMESIZE_SXGA},  // 1280x1024
    {"UXGA", FRAMESIZE_UXGA},  // 1600x1200 — sensor maximum
};
static const int N_RES = sizeof(RESOLUTIONS) / sizeof(RESOLUTIONS[0]);

static framesize_t resolveName(const String& name) {
  for (int i = 0; i < N_RES; i++)
    if (name.equalsIgnoreCase(RESOLUTIONS[i].name))
      return RESOLUTIONS[i].size;
  return FRAMESIZE_SVGA;
}

// ---------------------------------------------------------------------------
// Camera mutex
// ---------------------------------------------------------------------------

static SemaphoreHandle_t cameraMutex = nullptr;

static bool g_cameraReady = false;
static framesize_t currentFramesize = (framesize_t)-1;
static int currentQuality = -1;

// Initialize the camera if not already running. Must NOT be called with
// cameraMutex held — begin() can take hundreds of ms.
// Returns true on success.
static bool cameraEnsureReady() {
  if (g_cameraReady)
    return true;
  if (!boardCameraInit())
    return false;
  g_cameraReady = true;
  Log.println("Camera ready");
  return true;
}

// Stop the camera driver and release DMA buffers. Must NOT be called with
// cameraMutex held. Safe to call when already released.
static void cameraRelease() {
  if (!g_cameraReady)
    return;
  esp_camera_deinit();
  currentFramesize = (framesize_t)-1;
  currentQuality = -1;
  g_cameraReady = false;
  Log.println("Camera released");
}

// Must be called with cameraMutex held.
static void applyFramesize(framesize_t fs) {
  if (fs == currentFramesize)
    return;
  sensor_t* s = esp_camera_sensor_get();
  s->set_framesize(s, fs);
  currentFramesize = fs;
  delay(150);
  camera_fb_t* discard = esp_camera_fb_get();
  if (discard)
    esp_camera_fb_return(discard);
}

// Must be called with cameraMutex held.
static void applyQuality(int q) {
  if (q == currentQuality)
    return;
  sensor_t* s = esp_camera_sensor_get();
  s->set_quality(s, q);
  currentQuality = q;
}

// ---------------------------------------------------------------------------
// MJPEG stream constants
// ---------------------------------------------------------------------------

#define BOUNDARY "frame"
#define PART_HDR "\r\n--" BOUNDARY "\r\nContent-Type: image/jpeg\r\nContent-Length: "

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

static void confirmOtaIfNeeded();

void setup() {
  // The marker is only read from outside the running program (JS / incoming
  // OTA), so without an in-code reference the linker's --gc-sections drops it.
  asm volatile("" : : "r"(KIKKER_X_FW_VERSION_MARKER));

  Serial.begin(115200);
  delay(500);  // Wait for the serial monitor to attach before logging.
  logInit();
  {
    const esp_partition_t* part = esp_ota_get_running_partition();
    esp_ota_img_states_t ota_state;
    const char* state_str = "n/a";
    if (esp_ota_get_state_partition(part, &ota_state) == ESP_OK) {
      switch (ota_state) {
        case ESP_OTA_IMG_NEW:
          state_str = "new";
          break;
        case ESP_OTA_IMG_PENDING_VERIFY:
          state_str = "pending verify";
          break;
        case ESP_OTA_IMG_VALID:
          state_str = "valid";
          break;
        case ESP_OTA_IMG_INVALID:
          state_str = "invalid";
          break;
        case ESP_OTA_IMG_ABORTED:
          state_str = "aborted";
          break;
        case ESP_OTA_IMG_UNDEFINED:
          state_str = "undefined";
          break;
        default:
          state_str = "unknown";
          break;
      }
    }
    Log.printf("Partition: %s @ 0x%x, OTA status: %s\n", part->label, (unsigned)part->address, state_str);
  }
  Log.printf("KikkerX v%s\n", FIRMWARE_VERSION);
  getActiveConfig();  // parse and cache early so log output appears at startup
  boardBegin();

  cameraMutex = xSemaphoreCreateMutex();
  if (!cameraMutex) {
    Log.println("FATAL: failed to create camera mutex");
    for (;;)
      delay(1000);
  }

  wifiConnect();

  // Lower TX power to reduce heat; raise if range is insufficient.
  static const wifi_power_t WIFI_TX_POWER = WIFI_POWER_11dBm;
  WiFi.setTxPower(WIFI_TX_POWER);

  server.begin();
  g_mdnsName = getActiveConfig().mdns.c_str();
  if (wifiIsAP()) {
    Log.printf("Camera server ready in AP mode at http://%s/\n", WiFi.softAPIP().toString().c_str());
  } else {
    if (!g_mdnsName.isEmpty()) {
      if (!MDNS.begin(g_mdnsName.c_str()))
        Log.println("mDNS start failed");
      Log.printf("Camera server ready at http://%s/ (http://%s.local/)\n", WiFi.localIP().toString().c_str(),
          g_mdnsName.c_str());
    } else {
      Log.printf("Camera server ready at http://%s/\n", WiFi.localIP().toString().c_str());
    }
  }
  confirmOtaIfNeeded();
}

// ---------------------------------------------------------------------------
// Request handling helpers
// ---------------------------------------------------------------------------

// Reads headers, returning Content-Length (0 if absent).
// Captures the Authorization header value into authHeader.
static int readHeaders(WiFiClient& client, String& authHeader, String& originHeader) {
  int contentLength = 0;
  while (client.connected()) {
    String line = client.readStringUntil('\n');
    line.trim();
    if (line.length() == 0)
      break;
    String lower = line;
    lower.toLowerCase();
    if (lower.startsWith("content-length:")) {
      String val = line.substring(15);
      val.trim();
      contentLength = val.toInt();
      if (contentLength < 0)
        contentLength = 0;
    } else if (lower.startsWith("authorization:")) {
      authHeader = line.substring(14);
      authHeader.trim();
    } else if (lower.startsWith("origin:")) {
      originHeader = line.substring(7);
      originHeader.trim();
    }
  }
  return contentLength;
}

static String readBody(WiFiClient& client, int len) {
  String body;
  if (len <= 0)
    return body;
  unsigned long deadline = millis() + 1000;
  while ((int)body.length() < len && millis() < deadline) {
    if (client.available())
      body += (char)client.read();
    else
      delay(1);
  }
  return body;
}

static void printCors(WiFiClient& client, const String& origin) {
  if (origin.length() > 0 && getActiveConfig().allow_cors) {
    client.print("Access-Control-Allow-Origin: ");
    client.print(origin);
    // Retry-After is not in the CORS response-header safelist, so JS can't
    // read it on cross-origin responses unless we expose it explicitly. The
    // hub uses it to honor the firmware's "retry after N seconds" hint on 503.
    client.print("\r\nVary: Origin\r\nAccess-Control-Expose-Headers: Retry-After\r\n");
  }
}

static void endHeaders(WiFiClient& client, const String& origin) {
  printCors(client, origin);
  client.print("Connection: close\r\n\r\n");
}

static void send404(WiFiClient& client, const String& origin) {
  client.print("HTTP/1.1 404 Not Found\r\n");
  endHeaders(client, origin);
  client.stop();
  Log.println("→ 404");
}

static void send405(WiFiClient& client, const String& origin) {
  client.print("HTTP/1.1 405 Method Not Allowed\r\n");
  endHeaders(client, origin);
  client.stop();
  Log.println("→ 405");
}

// retryAfterSec > 0 emits a Retry-After header — tells the client that this
// 503 is transient and a short retry is worthwhile (e.g. camera busy with
// another capture). Omit for genuinely unavailable services.
static void send503(WiFiClient& client, const char* msg, const String& origin, int retryAfterSec = 0) {
  client.print("HTTP/1.1 503 Service Unavailable\r\nContent-Type: text/plain\r\n");
  if (retryAfterSec > 0) {
    client.printf("Retry-After: %d\r\n", retryAfterSec);
  }
  endHeaders(client, origin);
  client.print(msg);
  client.stop();
  Log.println("→ 503");
}

static void send403(WiFiClient& client, const char* msg, const String& origin) {
  client.print("HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\n");
  endHeaders(client, origin);
  client.print(msg);
  client.stop();
  Log.println("→ 403");
}

static void send400(WiFiClient& client, const char* msg, const String& origin) {
  client.print("HTTP/1.1 400 Bad Request\r\nContent-Type: text/plain\r\n");
  endHeaders(client, origin);
  client.print(msg);
  client.stop();
  Log.println("→ 400");
}

// ---------------------------------------------------------------------------
// OTA helpers
// ---------------------------------------------------------------------------

// Returns negative if a < b, 0 if equal, positive if a > b.
// Returns 0 (fail-open) if either string isn't parseable as semver.
static int compareSemver(const char* a, const char* b) {
  int amaj, amin, apatch, bmaj, bmin, bpatch;
  if (sscanf(a, "%d.%d.%d", &amaj, &amin, &apatch) != 3)
    return 0;
  if (sscanf(b, "%d.%d.%d", &bmaj, &bmin, &bpatch) != 3)
    return 0;
  if (amaj != bmaj)
    return amaj - bmaj;
  if (amin != bmin)
    return amin - bmin;
  return apatch - bpatch;
}

// Tell Arduino's initArduino() to skip its built-in OTA auto-confirm so that
// confirmOtaIfNeeded() can run the camera test first. The partition stays in
// PENDING_VERIFY state; if the app crashes before confirming, the bootloader
// sees PENDING_VERIFY on the next boot, marks it ABORTED, and rolls back.
extern "C" bool verifyRollbackLater() {
  return true;
}

// Streaming scanner for KIKKER_X_FW_VERSION=<ver>\0 anywhere in an incoming
// OTA upload. Processes one byte at a time via feed(); uses a small sliding
// window to match the marker across chunk boundaries. Memory: ~60 bytes.
class VersionScanner {
 public:
  static constexpr size_t MARKER_LEN = kMarkerPrefixLen();
  static constexpr size_t VERSION_MAX_LEN = 31;

  void feed(const uint8_t* data, size_t n) {
    for (size_t i = 0; i < n && !done_; i++) {
      uint8_t b = data[i];
      if (!matched_) {
        memmove(window_, window_ + 1, MARKER_LEN - 1);
        window_[MARKER_LEN - 1] = b;
        // Compare against the marker global, not the PREFIX literal — otherwise
        // the compiler emits a second "KIKKER_X_FW_VERSION=\0" literal that the
        // scanner would match first, reading \0 as the version.
        matched_ = memcmp(window_, KIKKER_X_FW_VERSION_MARKER, MARKER_LEN) == 0;
      } else if (b == 0 || versionFill_ >= VERSION_MAX_LEN) {
        done_ = true;  // versionBuf_ is zero-initialized, so already null-terminated.
      } else {
        versionBuf_[versionFill_++] = b;
      }
    }
  }
  bool done() const {
    return done_;
  }
  // Valid only after done() returns true.
  const char* version() const {
    return versionBuf_;
  }

 private:
  bool matched_ = false;
  bool done_ = false;
  // Starts zero-filled. MARKER contains no zero bytes, so a partially-filled
  // window can never match, and no fill counter is needed.
  uint8_t window_[MARKER_LEN] = {};
  char versionBuf_[VERSION_MAX_LEN + 1] = {};
  size_t versionFill_ = 0;
};

static void handleOTA(WiFiClient& client, int contentLength, const String& originHeader) {
  if (!getActiveConfig().allow_ota) {
    send404(client, originHeader);
    return;
  }
  if (contentLength <= 0) {
    send400(client, "Content-Length required.", originHeader);
    return;
  }
  const esp_partition_t* part = esp_ota_get_next_update_partition(NULL);
  if (!part) {
    send503(client, "No OTA partition.", originHeader);
    return;
  }
  esp_ota_handle_t handle = 0;
  if (esp_ota_begin(part, OTA_SIZE_UNKNOWN, &handle) != ESP_OK) {
    send503(client, "OTA begin failed.", originHeader);
    return;
  }
  stopStream();
  const char* runningVersion = FIRMWARE_VERSION;
  int remaining = contentLength;
  bool ok = true;
  esp_err_t werr = ESP_OK;
  bool versionDowngrade = false;
  char incomingVersion[VersionScanner::VERSION_MAX_LEN + 1] = {};
  uint8_t buf[1024];
  unsigned long deadline = millis() + 120000;
  VersionScanner scanner;
  bool versionCommitted = false;
  while (remaining > 0 && ok && millis() < deadline) {
    if (!client.connected() && !client.available()) {
      ok = false;
      break;
    }
    int avail = client.available();
    if (avail == 0) {
      delay(1);
      continue;
    }
    int toRead = min(remaining, min(avail, (int)sizeof(buf)));
    int n = client.read(buf, toRead);
    if (n <= 0) {
      delay(1);
      continue;
    }
    werr = esp_ota_write(handle, buf, n);
    if (werr != ESP_OK) {
      ok = false;
      continue;
    }
    remaining -= n;
    if (!versionCommitted) {
      scanner.feed(buf, n);
      if (scanner.done()) {
        versionCommitted = true;
        strlcpy(incomingVersion, scanner.version(), sizeof(incomingVersion));
        if (compareSemver(incomingVersion, runningVersion) < 0) {
          versionDowngrade = true;
          ok = false;
        } else {
          Log.printf("OTA: v%s → v%s\n", runningVersion, incomingVersion);
        }
      }
    }
  }
  // Drain remaining bytes so the browser finishes uploading before we send
  // the error response — otherwise it sees a connection reset instead of the
  // HTTP status. Skip draining on timeout; remaining data could be huge.
  auto drain = [&]() {
    unsigned long drainUntil = millis() + 10000;
    while (remaining > 0 && millis() < drainUntil) {
      if (!client.connected() && !client.available())
        break;
      int n = client.read(buf, min(remaining, (int)sizeof(buf)));
      if (n > 0)
        remaining -= n;
      else
        delay(1);
    }
  };
  if (versionDowngrade) {
    esp_ota_abort(handle);
    char msg[80];
    snprintf(msg, sizeof(msg), "Downgrade OTA not allowed (v%s → v%s).", runningVersion, incomingVersion);
    drain();
    send400(client, msg, originHeader);
    return;
  }
  if (!ok || remaining > 0) {
    esp_ota_abort(handle);
    char uploadErr[80];
    if (!ok) {
      const char* reason = (werr == ESP_ERR_OTA_VALIDATE_FAILED) ? "Not a valid firmware image." : "OTA write failed.";
      if (incomingVersion[0])
        snprintf(uploadErr, sizeof(uploadErr), "%s (v%s → v%s)", reason, runningVersion, incomingVersion);
      else
        strlcpy(uploadErr, reason, sizeof(uploadErr));
      drain();
    } else {
      strlcpy(uploadErr, "OTA upload timed out.", sizeof(uploadErr));
    }
    send503(client, uploadErr, originHeader);
    return;
  }
  if (esp_ota_end(handle) != ESP_OK) {
    char endErr[80];
    if (incomingVersion[0])
      snprintf(endErr, sizeof(endErr), "Firmware verification failed. (v%s → v%s)", runningVersion, incomingVersion);
    else
      strlcpy(endErr, "Firmware verification failed.", sizeof(endErr));
    send400(client, endErr, originHeader);
    return;
  }
  if (esp_ota_set_boot_partition(part) != ESP_OK) {
    send503(client, "Failed to set boot partition.", originHeader);
    return;
  }
  char successMsg[64];
  if (incomingVersion[0]) {
    snprintf(successMsg, sizeof(successMsg), "Updated v%s → v%s. Rebooting.", runningVersion, incomingVersion);
  } else {
    strlcpy(successMsg, "OTA update complete. Rebooting.", sizeof(successMsg));
  }
  client.print("HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n");
  endHeaders(client, originHeader);
  client.print(successMsg);
  client.flush();
  client.stop();
  Log.printf("→ 200 OTA complete (%s)\n", successMsg);
  delay(500);
  ESP.restart();
}

static void handleFirmwareGet(WiFiClient& client, const String& origin) {
  if (CONFIG_POLICY < CONFIG_POLICY_LOAD_OR_USE_DEFAULT) {
    send403(client, "Firmware download disabled (config policy embeds secrets).", origin);
    return;
  }
  const esp_partition_t* part = esp_ota_get_running_partition();
  if (!part) {
    send503(client, "Could not read running partition.", origin);
    return;
  }
  // Verify the image and get its exact size.
  esp_image_metadata_t meta;
  esp_partition_pos_t pos = {.offset = part->address, .size = part->size};
  if (esp_image_verify(ESP_IMAGE_VERIFY, &pos, &meta) != ESP_OK) {
    send503(client, "Could not read firmware image.", origin);
    return;
  }
  size_t totalSize = meta.image_len;

  char lenBuf[32];
  snprintf(lenBuf, sizeof(lenBuf), "%u", (unsigned)totalSize);
  client.print(
      "HTTP/1.1 200 OK\r\n"
      "Content-Type: application/octet-stream\r\n"
      "Content-Disposition: attachment; filename=\"firmware.bin\"\r\n"
      "Content-Length: ");
  client.print(lenBuf);
  client.print("\r\n");
  // Always send CORS for firmware downloads — the binary has no secrets.
  if (origin.length() > 0) {
    client.print("Access-Control-Allow-Origin: ");
    client.print(origin);
    client.print("\r\nVary: Origin\r\n");
  }
  client.print("Connection: close\r\n\r\n");

  uint8_t buf[1024];
  size_t sent = 0;
  while (sent < totalSize) {
    size_t chunk = min((size_t)sizeof(buf), totalSize - sent);
    if (esp_partition_read(part, sent, buf, chunk) != ESP_OK) {
      break;
    }
    client.write(buf, chunk);
    sent += chunk;
  }
  client.stop();
  Log.printf("→ 200 firmware GET %u bytes\n", (unsigned)sent);
}

// Called once in setup() to verify a newly installed OTA firmware.
// verifyRollbackLater() returns true, so Arduino's initArduino() skips its
// built-in auto-confirm and the partition stays in PENDING_VERIFY state here.
static void confirmOtaIfNeeded() {
  esp_ota_img_states_t state;
  const esp_partition_t* running = esp_ota_get_running_partition();
  if (esp_ota_get_state_partition(running, &state) != ESP_OK || state != ESP_OTA_IMG_PENDING_VERIFY)
    return;
  Log.println("OTA: experimental firmware — verifying...");
  xSemaphoreTake(cameraMutex, portMAX_DELAY);
  bool ok = cameraEnsureReady();
  if (ok) {
    camera_fb_t* fb = esp_camera_fb_get();
    if (fb) {
      esp_camera_fb_return(fb);
      Log.println("OTA: camera capture ok");
    } else {
      ok = false;
      Log.println("OTA: camera capture failed");
    }
    cameraRelease();
  } else {
    Log.println("OTA: camera init failed");
  }
  xSemaphoreGive(cameraMutex);
  if (ok) {
    Log.println("OTA: verification passed, firmware confirmed");
    esp_ota_mark_app_valid_cancel_rollback();
    return;
  }
  Log.println("OTA: verification failed, rolling back");
  esp_ota_mark_app_invalid_rollback_and_reboot();
}

// Send raw bytes in CHUNK-sized pieces. Returns true only if all sent.
static bool sendBytes(WiFiClient& client, const uint8_t* buf, size_t len) {
  static const size_t CHUNK = 4096;
  uint32_t stallStart = 0;
  while (len > 0) {
    size_t n = len > CHUNK ? CHUNK : len;
    int written = client.write(buf, n);
    if (written == 0) {
      // Send buffer temporarily full — give the TCP stack a moment to
      // flush before retrying. Bail if the client disconnected or if
      // no progress has been made for 3 s (SO_SNDTIMEO does not apply
      // to the non-blocking Arduino WiFiClient::write path).
      if (stallStart == 0)
        stallStart = millis();
      else if (millis() - stallStart > 3000)
        return false;
      delay(1);
      if (!client.connected())
        return false;
      continue;
    }
    if (written < 0)
      return false;
    stallStart = 0;
    buf += written;
    len -= written;
    // Let the WiFi stack process TCP ACKs between chunks.
    yield();
  }
  return true;
}

// Convenience wrapper for null-terminated text content.
static bool sendBody(WiFiClient& client, const char* body) {
  return sendBytes(client, (const uint8_t*)body, strlen(body));
}

// parseParam("GET /api/cam/stream.mjpeg?res=SVGA&quality=12 HTTP/1.1", "res") →
// "SVGA"
static String parseParam(const String& reqLine, const char* key) {
  int q = reqLine.indexOf('?');
  if (q < 0)
    return "";
  int end = reqLine.indexOf(' ', q);
  String qs = (end > 0) ? reqLine.substring(q + 1, end) : reqLine.substring(q + 1);
  String prefix = String(key) + "=";
  int pos = qs.indexOf(prefix);
  if (pos < 0)
    return "";
  int valStart = pos + prefix.length();
  int amp = qs.indexOf('&', valStart);
  return (amp > 0) ? qs.substring(valStart, amp) : qs.substring(valStart);
}

static int intParam(const String& reqLine, const char* key, int def) {
  String v = parseParam(reqLine, key);
  return v.length() > 0 ? v.toInt() : def;
}

// Must be called with cameraMutex held.
// Applies all OV3660 sensor settings derived from URL query parameters,
// using the same defaults as the stream and photo UIs.
static void applySensorSettings(sensor_t* s, const String& reqLine) {
  s->set_brightness(s, intParam(reqLine, "brightness", 0));
  s->set_contrast(s, intParam(reqLine, "contrast", 0));
  s->set_saturation(s, intParam(reqLine, "saturation", 0));
  s->set_sharpness(s, intParam(reqLine, "sharpness", 1));
  s->set_denoise(s, intParam(reqLine, "denoise", 0));
  s->set_ae_level(s, intParam(reqLine, "ae_level", 0));
  // wb_mode: 0=Auto, 1=Sunny, 2=Cloudy, 3=Office, 4=Home.
  // On OV3660 the preset modes are constrained-AWB modes, not fixed gains —
  // whitebal (AWB enable) must stay 1 for any mode; wb_mode selects the
  // algorithm. awb_gain must also be 1 for preset colour matrices to apply.
  int wbMode = intParam(reqLine, "wb_mode", 0);
  s->set_whitebal(s, 1);
  s->set_wb_mode(s, wbMode);
  s->set_awb_gain(s, wbMode != 0 ? 1 : intParam(reqLine, "awb_gain", 0));
  s->set_hmirror(s, intParam(reqLine, "hmirror", 0));
  s->set_vflip(s, intParam(reqLine, "vflip", 1));
  s->set_exposure_ctrl(s, intParam(reqLine, "aec", 1));
  s->set_aec_value(s, intParam(reqLine, "aec_value", 490));
  s->set_gain_ctrl(s, intParam(reqLine, "agc", 1));
  s->set_agc_gain(s, intParam(reqLine, "agc_gain", 2));
  s->set_gainceiling(s, (gainceiling_t)intParam(reqLine, "gainceiling", 248));
  s->set_aec2(s, intParam(reqLine, "aec2", 0));
  s->set_bpc(s, intParam(reqLine, "bpc", 1));
  s->set_wpc(s, intParam(reqLine, "wpc", 1));
  s->set_raw_gma(s, intParam(reqLine, "raw_gma", 1));
  s->set_lenc(s, intParam(reqLine, "lenc", 1));
  s->set_dcw(s, intParam(reqLine, "dcw", 1));
  s->set_colorbar(s, intParam(reqLine, "colorbar", 0));
}

// Extracts path from "GET /path?query HTTP/1.1" → "/path"
static String parsePath(const String& reqLine) {
  int start = reqLine.indexOf(' ');
  if (start < 0)
    return "/";
  start++;
  int end = reqLine.indexOf(' ', start);
  String url = (end > 0) ? reqLine.substring(start, end) : reqLine.substring(start);
  int q = url.indexOf('?');
  return (q >= 0) ? url.substring(0, q) : url;
}

static void serveStatic(WiFiClient& client, const StaticFile* f) {
  client.print("HTTP/1.1 200 OK\r\nContent-Type: ");
  client.print(f->contentType);
  client.print("\r\nContent-Encoding: gzip\r\nContent-Length: ");
  client.print(f->size);
  client.print("\r\nCache-Control: no-cache\r\n");
  client.print("Connection: close\r\n\r\n");
  bool ok = sendBytes(client, f->data, f->size);
  client.stop();
  if (ok)
    Log.printf("→ 200 %s\n", f->name);
  else
    Log.printf("→ err %s (send truncated)\n", f->name);
}

// ---------------------------------------------------------------------------
// API: LED
// ---------------------------------------------------------------------------

static void sendLedState(WiFiClient& client, const String& origin) {
  char buf[24];
  snprintf(buf, sizeof(buf), "{\"state\":%s}", g_ledState ? "true" : "false");
  client.print("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nCache-Control: no-cache\r\n");
  endHeaders(client, origin);
  client.print(buf);
  client.stop();
  Log.printf("→ 200 led state=%s\n", g_ledState ? "on" : "off");
}

static void handleLedGet(WiFiClient& client, const String& origin) {
  sendLedState(client, origin);
}

static void handleLedPatch(WiFiClient& client, const String& body, const String& origin) {
  cJSON* json = cJSON_Parse(body.c_str());
  if (json) {
    cJSON* state = cJSON_GetObjectItem(json, "state");
    if (cJSON_IsBool(state)) {
      g_ledState = cJSON_IsTrue(state);
      boardSetLed(g_ledState);
      Log.printf("LED → %s\n", g_ledState ? "on" : "off");
    }
    cJSON_Delete(json);
  }
  sendLedState(client, origin);
}

static void handleLedBlink(WiFiClient& client, const String& body, const String& origin) {
  String pattern = "200";
  cJSON* json = cJSON_Parse(body.c_str());
  if (json) {
    cJSON* pat = cJSON_GetObjectItem(json, "pattern");
    if (cJSON_IsString(pat) && pat->valuestring)
      pattern = pat->valuestring;
    cJSON_Delete(json);
  }

  // Validate: all tokens must be positive integers, total must not exceed 5000 ms.
  int total = 0;
  int pos = 0;
  while (true) {
    int comma = pattern.indexOf(',', pos);
    String tok = (comma >= 0) ? pattern.substring(pos, comma) : pattern.substring(pos);
    tok.trim();
    int ms = tok.toInt();
    if (ms <= 0) {
      client.print("HTTP/1.1 400 Bad Request\r\nContent-Type: text/plain\r\n");
      endHeaders(client, origin);
      client.print("Invalid pattern: each value must be a positive integer.");
      client.stop();
      return;
    }
    total += ms;
    if (total > 5000) {
      client.print("HTTP/1.1 400 Bad Request\r\nContent-Type: text/plain\r\n");
      endHeaders(client, origin);
      client.print("Pattern too long: total must not exceed 5000 ms.");
      client.stop();
      return;
    }
    if (comma < 0)
      break;
    pos = comma + 1;
  }

  client.print("HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n");
  endHeaders(client, origin);
  client.print("OK");
  client.stop();
  Log.printf("LED blink: %s (%d ms)\n", pattern.c_str(), total);

  bool saved = g_ledState;
  bool on = true;
  pos = 0;
  while (true) {
    int comma = pattern.indexOf(',', pos);
    String tok = (comma >= 0) ? pattern.substring(pos, comma) : pattern.substring(pos);
    tok.trim();
    boardSetLed(on);
    delay(tok.toInt());
    on = !on;
    if (comma < 0)
      break;
    pos = comma + 1;
  }
  g_ledState = saved;
  boardSetLed(g_ledState);
}

// ---------------------------------------------------------------------------
// API: status
// ---------------------------------------------------------------------------

static void getDeviceId(char out[13]) {
  uint64_t mac = ESP.getEfuseMac();
  snprintf(out, 13, "%02x%02x%02x%02x%02x%02x", (int)((mac >> 40) & 0xff), (int)((mac >> 32) & 0xff),
      (int)((mac >> 24) & 0xff), (int)((mac >> 16) & 0xff), (int)((mac >> 8) & 0xff), (int)(mac & 0xff));
}

static void handleStatus(WiFiClient& client, const String& reqLine, const String& origin) {
  BoardFeatures feat = boardFeatures();
  int batV = feat.battery ? boardBatteryVoltage() : 0;
  int batPct = feat.battery ? batteryLevel(batV) : 0;
  bool isAP = wifiIsAP();
  String ssid = isAP ? WiFi.softAPSSID() : WiFi.SSID();
  int32_t rssi = isAP ? 0 : WiFi.RSSI();

  String mode = parseParam(reqLine, "mode");

  // --- short_text ---
  if (mode == "short_text") {
    char buf[128];
    if (!isAP && feat.battery)
      snprintf(buf, sizeof(buf), "WiFi: %s (%ddB), Battery: %dmV (%d%%)", ssid.c_str(), (int)rssi, batV, batPct);
    else if (!isAP)
      snprintf(buf, sizeof(buf), "WiFi: %s (%ddB)", ssid.c_str(), (int)rssi);
    else if (feat.battery)
      snprintf(buf, sizeof(buf), "WiFi: %s, Battery: %dmV (%d%%)", ssid.c_str(), batV, batPct);
    else
      snprintf(buf, sizeof(buf), "WiFi: %s", ssid.c_str());
    client.print("HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nCache-Control: no-cache\r\n");
    endHeaders(client, origin);
    client.print(buf);
    client.stop();
    Log.println("→ 200 status short_text");
    return;
  }

  // --- short ---
  if (mode == "short") {
    cJSON* root = cJSON_CreateObject();
    cJSON* wifi = cJSON_CreateObject();
    cJSON_AddStringToObject(wifi, "ssid", ssid.c_str());
    if (!isAP)
      cJSON_AddNumberToObject(wifi, "rssi", rssi);
    cJSON_AddItemToObject(root, "wifi", wifi);
    if (feat.battery) {
      cJSON* battery = cJSON_CreateObject();
      cJSON_AddNumberToObject(battery, "voltage", batV);
      cJSON_AddNumberToObject(battery, "level", batPct);
      cJSON_AddItemToObject(root, "battery", battery);
    }
    char* json = cJSON_PrintUnformatted(root);
    cJSON_Delete(root);
    client.print("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nCache-Control: no-cache\r\n");
    endHeaders(client, origin);
    if (json) {
      client.print(json);
      free(json);
    }
    client.stop();
    Log.println("→ 200 status short");
    return;
  }

  // --- full (default) ---
  char macStr[13];
  getDeviceId(macStr);
  cJSON* root = cJSON_CreateObject();
  if (feat.battery) {
    cJSON* battery = cJSON_CreateObject();
    cJSON_AddNumberToObject(battery, "voltage", batV);
    cJSON_AddNumberToObject(battery, "level", batPct);
    cJSON_AddItemToObject(root, "battery", battery);
  }
  cJSON_AddStringToObject(root, "id", macStr);
  cJSON* wifi = cJSON_CreateObject();
  cJSON_AddStringToObject(wifi, "mode", isAP ? "ap" : "station");
  if (isAP) {
    cJSON_AddStringToObject(wifi, "ssid", ssid.c_str());
    cJSON_AddStringToObject(wifi, "ip", WiFi.softAPIP().toString().c_str());
  } else {
    cJSON_AddStringToObject(wifi, "ssid", ssid.c_str());
    cJSON_AddStringToObject(wifi, "ip", WiFi.localIP().toString().c_str());
    cJSON_AddNumberToObject(wifi, "rssi", rssi);
  }
  cJSON_AddItemToObject(root, "wifi", wifi);
  cJSON_AddStringToObject(root, "camera", "kikker-x");
  cJSON_AddStringToObject(root, "version", FIRMWARE_VERSION);
  cJSON_AddStringToObject(root, "config_policy", getConfigPolicyName());
  cJSON_AddBoolToObject(root, "allow_ota", getActiveConfig().allow_ota);
  cJSON* features = cJSON_CreateObject();
  cJSON_AddStringToObject(features, "board", feat.name);
  cJSON_AddBoolToObject(features, "led", feat.led);
  cJSON_AddBoolToObject(features, "battery", feat.battery);
  cJSON_AddItemToObject(root, "features", features);
  char* json = cJSON_PrintUnformatted(root);
  cJSON_Delete(root);
  client.print("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nCache-Control: no-cache\r\n");
  endHeaders(client, origin);
  if (json) {
    client.print(json);
    free(json);
  }
  client.stop();
  if (feat.battery)
    Log.printf("→ 200 status %dmV %d%% %s\n", (int)batV, (int)batPct, isAP ? "ap" : "station");
  else
    Log.printf("→ 200 status %s\n", isAP ? "ap" : "station");
}

// ---------------------------------------------------------------------------
// API: config inspection
// ---------------------------------------------------------------------------

// Builds {"is_active": bool, "schema_version": N, "config": <raw redacted JSON | null>}.
static cJSON* buildSourceEntry(const ConfigInfo& info) {
  cJSON* obj = cJSON_CreateObject();
  cJSON_AddBoolToObject(obj, "is_active", info.is_active);
  cJSON_AddNumberToObject(obj, "schema_version", info.schema_version);
  if (info.config) {
    cJSON_AddItemToObject(obj, "config", cJSON_CreateRaw(info.config->redactedJSON.c_str()));
  } else {
    cJSON_AddNullToObject(obj, "config");
  }
  return obj;
}

static void handleConfig(WiFiClient& client, const String& origin) {
  getActiveConfig();  // ensure active_source + is_active flags are set on the cached ConfigInfos
  const ConfigInfo& embedded = getEmbeddedConfig();
  const ConfigInfo& stored = getStoredConfig();
  const ConfigInfo& defaults = getFirmwareDefaults();

  cJSON* root = cJSON_CreateObject();
  cJSON_AddStringToObject(root, "policy", getConfigPolicyName());
  cJSON_AddStringToObject(root, "active_source", getConfigActiveSource());
  cJSON_AddNumberToObject(root, "schema_version", CONFIG_SCHEMA_VERSION);

  // stored: null when NVS is empty, else {is_active, schema_version, config (null if schema mismatch or parse fail)}.
  if (stored.schema_version == 0) {
    cJSON_AddNullToObject(root, "stored");
  } else {
    cJSON_AddItemToObject(root, "stored", buildSourceEntry(stored));
  }

  // embedded: null when policy doesn't use embedded (LOAD_OR_USE_DEFAULT, LOAD_OR_FAIL),
  // else {is_active, schema_version, config}. Parse failure would have shut down the device.
  if (embedded.schema_version == 0) {
    cJSON_AddNullToObject(root, "embedded");
  } else {
    cJSON_AddItemToObject(root, "embedded", buildSourceEntry(embedded));
  }

  // default: always present — firmware defaults.
  cJSON_AddItemToObject(root, "default", buildSourceEntry(defaults));

  char* out = cJSON_PrintUnformatted(root);
  cJSON_Delete(root);

  client.print("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nCache-Control: no-cache\r\n");
  endHeaders(client, origin);
  if (out) {
    client.print(out);
    free(out);
  }
  client.stop();
  Log.println("→ 200 config");
}

// ---------------------------------------------------------------------------
// API: hub status + store
// ---------------------------------------------------------------------------

static void handleHubStatus(WiFiClient& client, const String& origin) {
  client.print("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nCache-Control: no-cache\r\n");
  endHeaders(client, origin);
  client.print("{\"isStandalone\":false,\"store\":{\"read\":true}}");
  client.stop();
  Log.println("→ 200 hub/status");
}

static void handleHubStore(WiFiClient& client, const String& origin) {
  client.print("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nCache-Control: no-cache\r\n");
  endHeaders(client, origin);
  // "SELF" is a self-reference marker: the hub replaces it with window.location.origin
  // so the URL matches however the device was accessed (IP, mDNS, etc.).
  const string& authUser = getActiveConfig().auth.username;
  if (!authUser.empty()) {
    char macStr[13];
    getDeviceId(macStr);
    cJSON* j = cJSON_CreateString(authUser.c_str());
    char* escapedUser = cJSON_PrintUnformatted(j);
    cJSON_Delete(j);
    client.print("{\"version\":1,\"cameras\":[{\"url\":\"SELF\",\"type\":\"kikker-x\",\"authId\":\"auth-");
    client.print(macStr);
    client.print("\"}],\"auths\":[{\"id\":\"auth-");
    client.print(macStr);
    client.print("\",\"username\":");
    client.print(escapedUser);
    cJSON_free(escapedUser);
    client.print("}]}");
  } else {
    client.print("{\"version\":1,\"cameras\":[{\"url\":\"SELF\",\"type\":\"kikker-x\"}],\"auths\":[]}");
  }
  client.stop();
  Log.println("→ 200 hub/store");
}

// ---------------------------------------------------------------------------
// API: power off / timed sleep
// ---------------------------------------------------------------------------

// Execute a power-off or timed sleep. The HTTP response must already be sent
// and the client stopped before calling this. Never returns.
// Safe to call with the camera already released: cameraRelease() is idempotent.
static void doPowerOff(int duration) {
  delay(500);
  Serial.flush();
  if (duration == 0) {
    boardPowerOff();
  } else {
    cameraRelease();
    boardTimerSleep(duration);
  }
}

static void handlePowerOff(WiFiClient& client, const String& reqLine, const String& origin) {
  int duration = intParam(reqLine, "duration", 0);
  const char* body = duration == 0 ? "Powering off." : "Going to sleep.";
  client.print("HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n");
  endHeaders(client, origin);
  client.print(body);
  client.flush();
  client.stop();
  if (duration == 0)
    Log.println("→ 200 poweroff (permanent)");
  else
    Log.printf("→ 200 poweroff (sleep %ds)\n", duration);
  doPowerOff(duration);
}

// ---------------------------------------------------------------------------
// MJPEG stream
// ---------------------------------------------------------------------------

static void handleMjpeg(WiFiClient& client, const String& reqLine, const String& origin) {
  sensor_t* s = esp_camera_sensor_get();
  framesize_t streamFs = resolveName(parseParam(reqLine, "res"));
  int streamQuality = intParam(reqLine, "quality", 12);

  xSemaphoreTake(cameraMutex, portMAX_DELAY);
  applyFramesize(streamFs);
  applyQuality(streamQuality);
  applySensorSettings(s, reqLine);
  // Discard 2 frames so the sensor settles before we start streaming.
  // With GRAB_LATEST the DMA runs continuously; the first frame(s) may have
  // been captured before (or during) the settings write.
  for (int i = 0; i < 2; i++) {
    camera_fb_t* d = esp_camera_fb_get();
    if (d)
      esp_camera_fb_return(d);
  }
  xSemaphoreGive(cameraMutex);

  {
    int fd = client.fd();
    if (fd >= 0) {
      // Disable Nagle: the stream sends small boundary headers before each
      // frame; Nagle + receiver delayed-ACK would stall the pipeline ~200ms
      // per frame otherwise.
      int flag = 1;
      setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &flag, sizeof(flag));
      // Fail in 3 s so an abandoned connection is detected quickly,
      // freeing the camera for the next request.
      struct timeval tv = {3, 0};
      setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof(tv));
      int sndbuf = 32768;
      setsockopt(fd, SOL_SOCKET, SO_SNDBUF, &sndbuf, sizeof(sndbuf));
    }
  }

  client.print(
      "HTTP/1.1 200 OK\r\n"
      "Content-Type: multipart/x-mixed-replace;boundary=" BOUNDARY
      "\r\n"
      "Cache-Control: no-cache\r\n");
  printCors(client, origin);
  client.print("Connection: keep-alive\r\n\r\n");

  Log.printf("Stream started: res=%s quality=%d\n", parseParam(reqLine, "res").c_str(), streamQuality);

  int64_t lastUs = esp_timer_get_time();
  uint32_t frameCount = 0;
  bool writeError = false;
  int64_t totalCamUs = 0, totalSendUs = 0;

  while (client.connected() && !g_stopStream) {
    if (client.available())
      break;

    // Hold at the frame boundary while a capture is in progress. The stream
    // HTTP response stays open; the browser just sees a pause in frames.
    if (g_streamPause) {
      g_streamPaused = true;
      while (g_streamPause && client.connected() && !g_stopStream)
        delay(10);
      g_streamPaused = false;
      if (!client.connected() || g_stopStream)
        break;
      // Capture may have changed sensor params; restore stream settings.
      g_settingsDirty = true;
      continue;
    }

    int64_t t0 = esp_timer_get_time();

    xSemaphoreTake(cameraMutex, portMAX_DELAY);
    applyFramesize(streamFs);
    applyQuality(streamQuality);
    if (g_settingsDirty) {
      // A photo was taken with different settings — restore the stream's own
      // settings before capturing the next frame.
      applySensorSettings(s, reqLine);
      g_settingsDirty = false;
      // Discard the frame that was captured with the photo's settings.
      camera_fb_t* stale = esp_camera_fb_get();
      if (stale)
        esp_camera_fb_return(stale);
    }
    camera_fb_t* fb = esp_camera_fb_get();
    bool got = fb != nullptr;
    xSemaphoreGive(cameraMutex);

    if (!got) {
      delay(10);
      continue;
    }
    int64_t t1 = esp_timer_get_time();
    totalCamUs += t1 - t0;

    size_t frameLen = fb->len;
    client.print(PART_HDR);
    client.print(frameLen);
    client.print("\r\n\r\n");
    bool ok = sendBytes(client, fb->buf, frameLen);
    totalSendUs += esp_timer_get_time() - t1;

    xSemaphoreTake(cameraMutex, portMAX_DELAY);
    esp_camera_fb_return(fb);
    xSemaphoreGive(cameraMutex);

    if (!ok) {
      writeError = true;
      break;
    }

    frameCount++;
    if (frameCount % 20 == 0) {
      int64_t nowUs = esp_timer_get_time();
      float fps = 20.0f * 1e6f / (float)(nowUs - lastUs);
      g_streamFps = fps;
      uint32_t avgCamMs = (uint32_t)(totalCamUs / 20 / 1000);
      uint32_t avgSendMs = (uint32_t)(totalSendUs / 20 / 1000);
      Log.printf("Stream: %.1f FPS  frame=%uB  cam=%ums  send=%ums\n", fps, frameLen, avgCamMs, avgSendMs);
      lastUs = nowUs;
      totalCamUs = totalSendUs = 0;
    }
  }

  client.stop();
  g_streamFps = 0.0f;
  if (writeError)
    Log.printf("→ err stream ended after %u frames (write error)\n", frameCount);
  else
    Log.printf("→ 200 stream ended after %u frames (client closed)\n", frameCount);
  // NOTE: g_streamActive is cleared by streamTask after cameraRelease(),
  // so that stopStream() waiting on it guarantees the camera is fully released.
}

// ---------------------------------------------------------------------------
// API: logs
// ---------------------------------------------------------------------------

static void handleLogs(WiFiClient& client, const String& origin) {
  const char* p1;
  size_t l1;
  const char* p2;
  size_t l2;
  logGetParts(&p1, &l1, &p2, &l2);
  size_t total = l1 + l2;
  client.print("HTTP/1.1 200 OK\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ");
  client.print(total);
  client.print("\r\nCache-Control: no-cache\r\n");
  endHeaders(client, origin);
  if (l1)
    sendBytes(client, (const uint8_t*)p1, l1);
  if (l2)
    sendBytes(client, (const uint8_t*)p2, l2);
  client.stop();
  Log.printf("→ 200 logs %u bytes\n", total);
}

// ---------------------------------------------------------------------------
// API: stream FPS
// ---------------------------------------------------------------------------

static void handleStreamFps(WiFiClient& client, const String& origin) {
  char buf[48];
  snprintf(buf, sizeof(buf), "{\"fps\":%.1f,\"active\":%s}", g_streamFps.load(), g_streamActive ? "true" : "false");
  client.print("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nCache-Control: no-cache\r\n");
  endHeaders(client, origin);
  client.print(buf);
  client.stop();
}

struct StreamTaskArgs {
  WiFiClient client;
  String reqLine;
  String origin;
};

static void streamTask(void* arg) {
  StreamTaskArgs* args = (StreamTaskArgs*)arg;
  handleMjpeg(args->client, args->reqLine, args->origin);
  delete args;
  // If a capture task is in progress (stream client disconnected during pause),
  // let captureTask handle the camera release.
  if (!g_captureActive)
    cameraRelease();
  // Clear g_streamActive only after the camera is released.  loop() calls
  // stopStream() which busy-waits on this flag, so clearing it here guarantees
  // that any new stream request cannot start until cameraRelease() has
  // completed, preventing the new streamTask from using a camera being deinited
  // by this task.
  g_streamActive = false;
  vTaskDelete(NULL);
}

// ---------------------------------------------------------------------------
// Still photo capture
// ---------------------------------------------------------------------------

#define APPLY_IF_PRESENT(key, call)       \
  {                                       \
    String _v = parseParam(reqLine, key); \
    if (_v.length()) {                    \
      call;                               \
    }                                     \
  }

// Must be called with cameraMutex held.
// Applies only the OV3660 sensor settings that are explicitly present in the
// URL query string, leaving all others unchanged.
static void applyRawSensorSettings(sensor_t* s, const String& reqLine) {
  APPLY_IF_PRESENT("quality", applyQuality(_v.toInt()))
  APPLY_IF_PRESENT("brightness", s->set_brightness(s, _v.toInt()))
  APPLY_IF_PRESENT("contrast", s->set_contrast(s, _v.toInt()))
  APPLY_IF_PRESENT("saturation", s->set_saturation(s, _v.toInt()))
  APPLY_IF_PRESENT("sharpness", s->set_sharpness(s, _v.toInt()))
  APPLY_IF_PRESENT("denoise", s->set_denoise(s, _v.toInt()))
  APPLY_IF_PRESENT("ae_level", s->set_ae_level(s, _v.toInt()))
  APPLY_IF_PRESENT("wb_mode", {
    int wm = _v.toInt();
    s->set_whitebal(s, 1);
    s->set_wb_mode(s, wm);
  })
  APPLY_IF_PRESENT("hmirror", s->set_hmirror(s, _v.toInt()))
  APPLY_IF_PRESENT("vflip", s->set_vflip(s, _v.toInt()))
  APPLY_IF_PRESENT("aec", s->set_exposure_ctrl(s, _v.toInt()))
  APPLY_IF_PRESENT("aec_value", s->set_aec_value(s, _v.toInt()))
  APPLY_IF_PRESENT("agc", s->set_gain_ctrl(s, _v.toInt()))
  APPLY_IF_PRESENT("agc_gain", s->set_agc_gain(s, _v.toInt()))
  APPLY_IF_PRESENT("gainceiling", s->set_gainceiling(s, (gainceiling_t)_v.toInt()))
  APPLY_IF_PRESENT("awb_gain", s->set_awb_gain(s, _v.toInt()))
  APPLY_IF_PRESENT("aec2", s->set_aec2(s, _v.toInt()))
  APPLY_IF_PRESENT("bpc", s->set_bpc(s, _v.toInt()))
  APPLY_IF_PRESENT("wpc", s->set_wpc(s, _v.toInt()))
  APPLY_IF_PRESENT("raw_gma", s->set_raw_gma(s, _v.toInt()))
  APPLY_IF_PRESENT("lenc", s->set_lenc(s, _v.toInt()))
  APPLY_IF_PRESENT("dcw", s->set_dcw(s, _v.toInt()))
  APPLY_IF_PRESENT("colorbar", s->set_colorbar(s, _v.toInt()))
}

static void handleCapture(WiFiClient& client, const String& reqLine, const String& origin) {
  sensor_t* s = esp_camera_sensor_get();
  String resName = parseParam(reqLine, "res");
  framesize_t fs = resName.length() > 0 ? resolveName(resName) : FRAMESIZE_UXGA;

  bool rawMode = intParam(reqLine, "raw", 0) != 0;

  xSemaphoreTake(cameraMutex, portMAX_DELAY);
  applyFramesize(fs);

  if (!rawMode) {
    applyQuality(intParam(reqLine, "quality", 4));
    applySensorSettings(s, reqLine);
  } else {
    applyRawSensorSettings(s, reqLine);
  }

  // At SXGA/UXGA the sensor runs at ~5–7 fps, so 2 stale frames cover only
  // ~300–400 ms — not enough for AEC to converge. Discard more frames at
  // large resolutions to let exposure settle before the keeper shot.
  delay(300);
  int staleCount = (fs >= FRAMESIZE_SXGA) ? 6 : 2;
  for (int i = 0; i < staleCount; i++) {
    camera_fb_t* stale = esp_camera_fb_get();
    if (stale)
      esp_camera_fb_return(stale);
  }
  camera_fb_t* fb = esp_camera_fb_get();
  xSemaphoreGive(cameraMutex);

  if (!fb) {
    client.print("HTTP/1.1 500 Internal Server Error\r\n");
    endHeaders(client, origin);
    client.stop();
    Log.println("→ 500 capture: esp_camera_fb_get returned null");
    return;
  }

  Log.printf("Capture: %ux%u %uB\n", fb->width, fb->height, fb->len);

  {
    int fd = client.fd();
    if (fd >= 0) {
      struct timeval tv = {10, 0};
      setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof(tv));
      int sndbuf = 32768;
      setsockopt(fd, SOL_SOCKET, SO_SNDBUF, &sndbuf, sizeof(sndbuf));
      // Disable Nagle: send each chunk immediately without waiting for ACK.
      // Nagle + receiver delayed-ACK interact to stall transfers by ~200
      // ms/RTT.
      int flag = 1;
      setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &flag, sizeof(flag));
    }
  }

  uint16_t capW = fb->width, capH = fb->height;
  size_t capLen = fb->len;
  client.print("HTTP/1.1 200 OK\r\nContent-Type: image/jpeg\r\n");
  printCors(client, origin);
  client.print("Content-Length: ");
  client.print(capLen);
  client.print("\r\nConnection: close\r\n\r\n");

  bool ok = sendBytes(client, fb->buf, capLen);

  esp_camera_fb_return(fb);
  client.stop();
  if (ok)
    Log.printf("→ 200 capture %ux%u %uB\n", capW, capH, capLen);
  else
    Log.printf("→ err capture %ux%u %uB (send truncated)\n", capW, capH, capLen);
}

struct CaptureTaskArgs {
  WiFiClient client;
  String reqLine;
  bool wasStreaming;
  String origin;
};

static void captureTask(void* arg) {
  CaptureTaskArgs* args = (CaptureTaskArgs*)arg;
  bool wasStreaming = args->wasStreaming;
  String reqLine = args->reqLine;
  String origin = args->origin;
  handleCapture(args->client, args->reqLine, origin);
  delete args;

  if (wasStreaming) {
    // Tell stream to restore its own settings on the next frame.
    g_settingsDirty = true;
    // Release the pause so the stream loop can resume.
    g_streamPause = false;
    // If the stream client disconnected while we were paused, the stream
    // task skipped cameraRelease() — we must do it here instead.
    if (!g_streamActive)
      cameraRelease();
  } else {
    cameraRelease();
  }
  g_captureActive = false;

  vTaskDelete(NULL);
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

// Asks the running stream to pause at the next frame boundary and waits up to
// 3 s for acknowledgement. Returns true if the stream is now paused (caller
// owns the camera). Returns false if there was no stream, or the stream exited
// before it could acknowledge (treat as no stream).
static bool pauseStreamForCapture() {
  if (!g_streamActive)
    return false;
  g_streamPause = true;
  unsigned long deadline = millis() + 3000;
  while (!g_streamPaused && g_streamActive && millis() < deadline)
    delay(10);
  if (!g_streamPaused) {
    g_streamPause = false;
    return false;
  }
  return true;
}

void loop() {
  delay(10);

  if (wifiMaintain() && !wifiIsAP() && !g_mdnsName.isEmpty())
    if (!MDNS.begin(g_mdnsName.c_str()))
      Log.println("mDNS start failed");

  WiFiClient client = server.available();
  if (!client)
    return;

  unsigned long deadline = millis() + 2000;
  while (!client.available() && millis() < deadline)
    delay(1);
  if (!client.available()) {
    client.stop();
    return;
  }

  String reqLine = client.readStringUntil('\n');
  reqLine.trim();
  String authHeader;
  String originHeader;
  int bodyLen = readHeaders(client, authHeader, originHeader);

  Log.println(reqLine);

  bool isGet = reqLine.startsWith("GET ");
  bool isPost = reqLine.startsWith("POST ");
  bool isPatch = reqLine.startsWith("PATCH ");
  bool isOptions = reqLine.startsWith("OPTIONS ");

  // Handle CORS preflight before auth check — preflights carry no credentials.
  if (isOptions) {
    client.print("HTTP/1.1 204 No Content\r\n");
    if (originHeader.length() > 0 && getActiveConfig().allow_cors) {
      client.print("Access-Control-Allow-Origin: ");
      client.print(originHeader);
      client.print(
          "\r\nAccess-Control-Allow-Methods: GET, POST, PATCH\r\n"
          "Access-Control-Allow-Headers: Authorization\r\n"
          "Access-Control-Max-Age: 86400\r\n"
          "Vary: Origin\r\n");
    }
    client.print("Connection: close\r\n\r\n");
    client.stop();
    Log.println("→ 204 OPTIONS");
    return;
  }

  if (!isGet && !isPost && !isPatch) {
    send405(client, originHeader);
    return;
  }

  String path = parsePath(reqLine);

  if (path != "/manifest.json" && path != "/logo.svg" && path != "/logo.png" && !authCheck(authHeader)) {
    authDeny(client, originHeader);
    return;
  }

  // --- POST routes ---
  if (isPost) {
    if (path == "/api/firmware") {
      handleOTA(client, bodyLen, originHeader);
      return;
    }
    String body = readBody(client, bodyLen);
    if (path == "/api/restart") {
      client.print("HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n");
      endHeaders(client, originHeader);
      client.print("Restarting.");
      client.flush();
      client.stop();
      Log.println("→ 200 restart");
      delay(500);
      ESP.restart();
    } else if (path == "/api/wifi/reconnect") {
      client.print("HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n");
      endHeaders(client, originHeader);
      client.print("Reconnecting to WiFi.");
      client.flush();
      client.stop();
      Log.println("→ 200 wifi reconnect");
      delay(3000);
      WiFi.disconnect();
      wifiConnect();
      if (!wifiIsAP() && !g_mdnsName.isEmpty())
        if (!MDNS.begin(g_mdnsName.c_str()))
          Log.println("mDNS start failed");
    } else if (path == "/api/poweroff")
      handlePowerOff(client, reqLine, originHeader);
    else if (path == "/api/led/blink") {
      if (!boardFeatures().led)
        send404(client, originHeader);
      else
        handleLedBlink(client, body, originHeader);
    } else
      send405(client, originHeader);
    return;
  }

  // --- PATCH routes ---
  if (isPatch) {
    String body = readBody(client, bodyLen);
    if (path == "/api/led") {
      if (!boardFeatures().led)
        send404(client, originHeader);
      else
        handleLedPatch(client, body, originHeader);
    } else
      send405(client, originHeader);
    return;
  }

  // --- Catalog lookup (GET only) ---
  String lookup;
  if (path == "/") {
    lookup = "index.html";
  } else {
    lookup = path.substring(1);
    if (lookup.indexOf('.') < 0)
      lookup += ".html";
  }
  const StaticFile* sf = staticFind(lookup.c_str());
  if (sf) {
    serveStatic(client, sf);
    return;
  }

  // --- GET API routes ---
  if (path.startsWith("/api/")) {
    if (path == "/api/firmware") {
      handleFirmwareGet(client, originHeader);
    } else if (path == "/api/logs") {
      handleLogs(client, originHeader);
    } else if (path == "/api/hub/status") {
      handleHubStatus(client, originHeader);
    } else if (path == "/api/hub/store") {
      handleHubStore(client, originHeader);
    } else if (path == "/api/status") {
      handleStatus(client, reqLine, originHeader);
    } else if (path == "/api/config") {
      handleConfig(client, originHeader);
    } else if (path == "/api/led") {
      if (!boardFeatures().led)
        send404(client, originHeader);
      else
        handleLedGet(client, originHeader);
    } else if (path == "/api/streamfps") {
      handleStreamFps(client, originHeader);
    } else if (path == "/api/cam/stream.mjpeg") {
      // Near-simultaneous requests to /api/cam/* race on g_captureActive — one
      // wins, another could land while the task is still finishing. Rather
      // than fail fast, wait briefly for the in-flight capture to complete.
      for (int waited = 0; g_captureActive && waited < 2000; waited += 50)
        vTaskDelay(pdMS_TO_TICKS(50));
      if (g_captureActive) {
        send503(client, "Capture in progress.", originHeader, 1);
        return;
      }
      stopStream();
      if (!cameraEnsureReady()) {
        send503(client, "Camera unavailable.", originHeader);
        return;
      }
      g_streamActive = true;
      StreamTaskArgs* args = new StreamTaskArgs{client, reqLine, originHeader};
      if (xTaskCreate(streamTask, "stream", 8192, args, 1, NULL) != pdPASS) {
        g_streamActive = false;
        delete args;
        cameraRelease();
        send503(client, "Out of resources.", originHeader);
      }
    } else if (path == "/api/cam/capture.jpg") {
      for (int waited = 0; g_captureActive && waited < 2000; waited += 50)
        vTaskDelay(pdMS_TO_TICKS(50));
      if (g_captureActive) {
        send503(client, "Capture in progress.", originHeader, 1);
        return;
      }
      bool wasStreaming = pauseStreamForCapture();
      if (!wasStreaming && !cameraEnsureReady()) {
        send503(client, "Camera unavailable.", originHeader);
        return;
      }
      // Set g_captureActive before xTaskCreate so the flag is visible to other
      // tasks (stream, main loop) before captureTask starts running.
      g_captureActive = true;
      CaptureTaskArgs* args = new CaptureTaskArgs{client, reqLine, wasStreaming, originHeader};
      if (xTaskCreate(captureTask, "capture", 8192, args, 1, NULL) != pdPASS) {
        g_captureActive = false;
        delete args;
        if (wasStreaming)
          g_streamPause = false;  // let the stream resume
        else
          cameraRelease();
        send503(client, "Out of resources.", originHeader);
      }
    } else {
      send404(client, originHeader);
    }
    return;
  }

  send404(client, originHeader);
}
