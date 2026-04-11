#include <M5TimerCAM.h>

#include "board.h"
#include "log.h"

BoardFeatures boardFeatures() {
  return {.name = "M5Stack Timer Camera X", .led = true, .battery = true};
}

void boardBegin() {
  TimerCAM.begin(true);  // true = enable RTC (BM8563) for boardTimerSleep()
}

bool boardCameraInit() {
  if (!TimerCAM.Camera.begin())
    return false;
  sensor_t* s = TimerCAM.Camera.sensor;
  s->set_pixformat(s, PIXFORMAT_JPEG);
  s->set_vflip(s, 1);
  s->set_hmirror(s, 0);
  return true;
}

void boardSetLed(bool on) {
  TimerCAM.Power.setLed(on ? 255 : 0);
}

BatteryData boardBattery() {
  return {TimerCAM.Power.getBatteryVoltage(), TimerCAM.Power.getBatteryLevel()};
}

void boardPowerOff() {
  TimerCAM.Power.powerOff();
}

void boardTimerSleep(int seconds) {
  // The camera driver (sccb_i2c_port=0) shares the I2C bus (GPIO12/14) with
  // the BM8563 RTC. The caller must release the camera before calling this so
  // that Wire can communicate with the RTC cleanly.
  TimerCAM.Rtc.begin();
  TimerCAM.Power.timerSleep(seconds);
}
