#pragma once

#define INCBIN_PREFIX
#define INCBIN_STYLE INCBIN_STYLE_SNAKE

#include <incbin.h>
#include <string.h>

struct StaticFile {
  const char* name;
  const char* contentType;
  const uint8_t* data;
  size_t size;
};

#include "_static_files.h"

static const int STATIC_CATALOG_SIZE = sizeof(STATIC_CATALOG) / sizeof(STATIC_CATALOG[0]);

static const StaticFile* staticFind(const char* name) {
  for (int i = 0; i < STATIC_CATALOG_SIZE; i++)
    if (strcmp(STATIC_CATALOG[i].name, name) == 0)
      return &STATIC_CATALOG[i];
  return nullptr;
}
