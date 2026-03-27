#include "log.h"

#include <Arduino.h>

static char* _buf = nullptr;
static size_t _write = 0;  // next write position
static bool _full = false;  // true once the buffer has wrapped

void logInit() {
  _buf = (char*)ps_malloc(LOG_BUF_SIZE);
  if (!_buf)
    _buf = (char*)malloc(LOG_BUF_SIZE);
}

static void ringWrite(const uint8_t* data, size_t len) {
  if (!_buf || len == 0)
    return;
  if (len >= LOG_BUF_SIZE) {
    // Incoming chunk larger than the whole buffer — keep only the tail end.
    data += len - LOG_BUF_SIZE;
    len = LOG_BUF_SIZE;
    _write = 0;
    _full = true;
  }
  size_t space = LOG_BUF_SIZE - _write;
  if (len <= space) {
    memcpy(_buf + _write, data, len);
    _write += len;
    if (_write == LOG_BUF_SIZE) {
      _write = 0;
      _full = true;
    }
  } else {
    memcpy(_buf + _write, data, space);
    memcpy(_buf, data + space, len - space);
    _write = len - space;
    _full = true;
  }
}

void logGetParts(const char** p1, size_t* l1, const char** p2, size_t* l2) {
  if (!_buf) {
    *p1 = nullptr;
    *l1 = 0;
    *p2 = nullptr;
    *l2 = 0;
    return;
  }
  if (!_full) {
    *p1 = _buf;
    *l1 = _write;
    *p2 = nullptr;
    *l2 = 0;
  } else {
    *p1 = _buf + _write;
    *l1 = LOG_BUF_SIZE - _write;
    *p2 = _buf;
    *l2 = _write;
  }
}

LogPrint Log;

size_t LogPrint::write(uint8_t c) {
  Serial.write(c);
  ringWrite(&c, 1);
  return 1;
}

size_t LogPrint::write(const uint8_t* buf, size_t size) {
  Serial.write(buf, size);
  ringWrite(buf, size);
  return size;
}
