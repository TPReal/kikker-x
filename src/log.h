#pragma once

#include <Print.h>

// Ring buffer capacity — enough for ~300 typical log lines.
static const size_t LOG_BUF_SIZE = 32 * 1024;

// Allocate the ring buffer. Call once in setup(), after Serial.begin().
void logInit();

// Return the two contiguous segments of the ring buffer, oldest data first.
// Either length may be zero (p2/l2 are zero when the buffer has not yet wrapped).
void logGetParts(const char** p1, size_t* l1, const char** p2, size_t* l2);

// Drop-in for Serial: mirrors every write to the UART and to the ring buffer.
class LogPrint : public Print {
 public:
  size_t write(uint8_t c) override;
  size_t write(const uint8_t* buf, size_t size) override;
  using Print::write;
};

extern LogPrint Log;
