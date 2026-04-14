#pragma once

// Returns battery level 0–100 from a single-cell LiPo voltage in mV.
// Uses a piecewise-linear approximation of a typical LiPo discharge curve.
int batteryLevel(int voltageMilliVolts);
