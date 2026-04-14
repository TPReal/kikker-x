#include <Arduino.h>
#include <Wire.h>
#include <driver/adc.h>
#include <esp_adc_cal.h>
#include <esp_camera.h>
#include <esp_sleep.h>

#include "board.h"
#include "log.h"

// ---------------------------------------------------------------------------
// Pin configuration for M5Stack Timer Camera X.
// Source: m5stack/Timer-CAM library (Camera_Class.h, Power_Class.h).
// ---------------------------------------------------------------------------

// Camera
#define CAM_PIN_PWDN -1
#define CAM_PIN_RESET 15
#define CAM_PIN_XCLK 27
#define CAM_PIN_SIOD 25
#define CAM_PIN_SIOC 23
#define CAM_PIN_D7 19
#define CAM_PIN_D6 36
#define CAM_PIN_D5 18
#define CAM_PIN_D4 39
#define CAM_PIN_D3 5
#define CAM_PIN_D2 34
#define CAM_PIN_D1 35
#define CAM_PIN_D0 32
#define CAM_PIN_VSYNC 22
#define CAM_PIN_HREF 26
#define CAM_PIN_PCLK 21

// Power hold — GPIO33 must stay HIGH or the device powers off.
#define POWER_HOLD_PIN 33

// LED — active-high on GPIO2.
#define LED_PIN 2

// Battery ADC — GPIO38 (ADC1 channel 2), voltage divider with scale factor 0.661.
#define BAT_ADC_CHANNEL ADC1_CHANNEL_2
#define BAT_ADC_SAMPLES 64
#define BAT_BASE_VOLTAGE 3600
#define BAT_SCALE 0.661f

// BM8563 RTC — I2C on GPIO12 (SDA) / GPIO14 (SCL).
#define RTC_SDA 12
#define RTC_SCL 14
#define RTC_ADDR 0x51

static esp_adc_cal_characteristics_t adcChars;

// ---------------------------------------------------------------------------
// BM8563 RTC helpers — just enough to set a countdown timer and power off.
// ---------------------------------------------------------------------------

static void rtcWriteReg(uint8_t reg, uint8_t val) {
  Wire.beginTransmission(RTC_ADDR);
  Wire.write(reg);
  Wire.write(val);
  Wire.endTransmission();
}

// Set a countdown alarm on the BM8563. afterSeconds: 1–15300.
// For values < 270 the timer runs in 1-second mode; otherwise 1-minute mode.
static void rtcSetAlarm(int afterSeconds) {
  // Disable existing alarms and timer.
  uint8_t disableBuf[] = {0x80, 0x80, 0x80, 0x80};
  Wire.beginTransmission(RTC_ADDR);
  Wire.write(0x09);
  Wire.write(disableBuf, 4);
  Wire.endTransmission();
  rtcWriteReg(0x0E, 0x00);
  rtcWriteReg(0x01, 0x00);

  // Configure countdown.
  uint8_t timerCtrl;
  int count;
  if (afterSeconds < 270) {
    count = (afterSeconds > 255) ? 255 : afterSeconds;
    timerCtrl = 0x82;  // enable, 1 Hz source
  } else {
    count = (afterSeconds + 30) / 60;
    if (count > 255)
      count = 255;
    timerCtrl = 0x83;  // enable, 1/60 Hz source
  }
  rtcWriteReg(0x0E, timerCtrl);
  rtcWriteReg(0x0F, (uint8_t)count);

  // Enable timer interrupt.
  rtcWriteReg(0x01, 0x01);
}

// ---------------------------------------------------------------------------

BoardFeatures boardFeatures() {
  return {.name = "M5Stack Timer Camera X", .led = true, .battery = true};
}

void boardBegin() {
  // Keep the power latch high — releasing it powers off the device.
  pinMode(POWER_HOLD_PIN, OUTPUT);
  digitalWrite(POWER_HOLD_PIN, HIGH);

  // LED off at startup.
  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, LOW);

  // Battery ADC calibration.
  adc1_config_width(ADC_WIDTH_BIT_12);
  adc1_config_channel_atten(BAT_ADC_CHANNEL, ADC_ATTEN_DB_12);
  esp_adc_cal_characterize(ADC_UNIT_1, ADC_ATTEN_DB_12, ADC_WIDTH_BIT_12, BAT_BASE_VOLTAGE, &adcChars);
}

bool boardCameraInit() {
  camera_config_t config = {};
  config.ledc_channel = LEDC_CHANNEL_0;
  config.ledc_timer = LEDC_TIMER_0;
  config.pin_pwdn = CAM_PIN_PWDN;
  config.pin_reset = CAM_PIN_RESET;
  config.pin_xclk = CAM_PIN_XCLK;
  config.pin_sccb_sda = CAM_PIN_SIOD;
  config.pin_sccb_scl = CAM_PIN_SIOC;
  config.pin_d7 = CAM_PIN_D7;
  config.pin_d6 = CAM_PIN_D6;
  config.pin_d5 = CAM_PIN_D5;
  config.pin_d4 = CAM_PIN_D4;
  config.pin_d3 = CAM_PIN_D3;
  config.pin_d2 = CAM_PIN_D2;
  config.pin_d1 = CAM_PIN_D1;
  config.pin_d0 = CAM_PIN_D0;
  config.pin_vsync = CAM_PIN_VSYNC;
  config.pin_href = CAM_PIN_HREF;
  config.pin_pclk = CAM_PIN_PCLK;
  config.xclk_freq_hz = 20000000;
  config.pixel_format = PIXFORMAT_JPEG;
  config.frame_size = FRAMESIZE_UXGA;
  config.jpeg_quality = 12;
  config.fb_count = 2;
  config.fb_location = CAMERA_FB_IN_PSRAM;
  config.grab_mode = CAMERA_GRAB_LATEST;
  config.sccb_i2c_port = 0;

  if (esp_camera_init(&config) != ESP_OK) {
    Log.println("Camera init failed");
    return false;
  }
  sensor_t* s = esp_camera_sensor_get();
  s->set_vflip(s, 1);
  s->set_hmirror(s, 0);
  return true;
}

void boardSetLed(bool on) {
  digitalWrite(LED_PIN, on ? HIGH : LOW);
}

int boardBatteryVoltage() {
  uint32_t raw = 0;
  for (int i = 0; i < BAT_ADC_SAMPLES; i++) {
    raw += adc1_get_raw(BAT_ADC_CHANNEL);
  }
  raw /= BAT_ADC_SAMPLES;
  return (int)(esp_adc_cal_raw_to_voltage(raw, &adcChars) / BAT_SCALE);
}

void boardPowerOff() {
  digitalWrite(POWER_HOLD_PIN, LOW);
  esp_deep_sleep_start();
}

void boardTimerSleep(int seconds) {
  // The camera driver (sccb_i2c_port=0) shares the I2C bus (GPIO12/14) with
  // the BM8563 RTC. The caller must release the camera before calling this so
  // that Wire can communicate with the RTC cleanly.
  Wire.begin(RTC_SDA, RTC_SCL);
  rtcWriteReg(0x00, 0x00);  // control/status 1: normal mode
  rtcWriteReg(0x0E, 0x03);  // timer control: enable, 1/60 Hz

  rtcSetAlarm(seconds);
  boardPowerOff();
}
