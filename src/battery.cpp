#include "battery.h"

// Typical single-cell LiPo discharge curve (approximate).
// Voltage drops steeply below 3.5 V and is nearly flat from 3.7–4.0 V.
static const struct {
  int mv;
  int pct;
} LIPO_CURVE[] = {
    {4200, 100},
    {4100, 100},
    {4060, 90},
    {3980, 80},
    {3920, 70},
    {3870, 60},
    {3830, 50},
    {3790, 40},
    {3750, 30},
    {3700, 20},
    {3600, 10},
    {3500, 5},
    {3300, 0},
};

static const int CURVE_LEN = sizeof(LIPO_CURVE) / sizeof(LIPO_CURVE[0]);

int batteryLevel(int voltageMilliVolts) {
  if (voltageMilliVolts >= LIPO_CURVE[0].mv)
    return 100;
  if (voltageMilliVolts <= LIPO_CURVE[CURVE_LEN - 1].mv)
    return 0;
  for (int i = 1; i < CURVE_LEN; i++) {
    if (voltageMilliVolts >= LIPO_CURVE[i].mv) {
      int hi = LIPO_CURVE[i - 1].mv;
      int lo = LIPO_CURVE[i].mv;
      int pHi = LIPO_CURVE[i - 1].pct;
      int pLo = LIPO_CURVE[i].pct;
      return pLo + (voltageMilliVolts - lo) * (pHi - pLo) / (hi - lo);
    }
  }
  return 0;
}
