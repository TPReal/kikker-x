#pragma once
#include <Arduino.h>

// Connect to the strongest known WiFi network.
// If no known network is found after MAX_CONNECT_ATTEMPTS scan cycles and an
// AP fallback is configured, starts a soft access point and returns.
// Retries indefinitely when no AP fallback is configured.
void wifiConnect();

// Call once per loop() iteration.
// In station mode: reconnects on drop; periodically scans and roams to a
// significantly stronger known network.
// In AP mode: periodically scans for known networks and switches back to
// station mode when one becomes visible.
// Returns true when a (re)connection event just completed — caller should
// re-init anything that depends on the network address (e.g. mDNS).
bool wifiMaintain();

// Returns true while the device is running as a soft access point.
bool wifiIsAP();
