#pragma once

#include <stdint.h>

struct BoardFeatures {
  const char* name;
  bool led;
  bool battery;
};

// Called once in setup() before anything else.
void boardBegin();

// Board capabilities — constant for the lifetime of the firmware.
BoardFeatures boardFeatures();

// Initialize the camera with board-specific pin config and sensor defaults.
// Returns true on success.
bool boardCameraInit();

// LED control. Only meaningful if boardFeatures().led.
void boardSetLed(bool on);

// Battery voltage in mV. Only meaningful if boardFeatures().battery.
int boardBatteryVoltage();

// Power management. These never return.
void boardPowerOff();
void boardTimerSleep(int seconds);
