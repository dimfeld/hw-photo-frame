#pragma once
#include <cstdint>
#include "esp_lcd_panel_ops.h"
constexpr int WIDTH = 1024;
constexpr int HEIGHT = 600;
constexpr size_t FRAME_BYTES = WIDTH * HEIGHT * sizeof(uint16_t);
esp_lcd_panel_handle_t board_init();
void board_show_status(const char *text);
// Returns false on a bus error or when the controller has no new data.
bool board_touch(uint16_t &x, bool &pressed);
