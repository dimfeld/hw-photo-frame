#include "board.h"
#include "driver/i2c_master.h"
#include "driver/gpio.h"
#include "esp_lcd_panel_rgb.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include <algorithm>
#include <cstring>

static i2c_master_dev_handle_t touch;
static uint16_t *frame_buffer;

static void wait_until(int64_t due) {
    while (esp_timer_get_time() < due) {
        const int64_t ticks = (due - esp_timer_get_time()) / (1000000 / configTICK_RATE_HZ);
        vTaskDelay(static_cast<TickType_t>(std::max<int64_t>(1, std::min<int64_t>(ticks, portMAX_DELAY - 1))));
    }
}

static const uint8_t FONT[26][5] = {
    {0x7e, 0x09, 0x09, 0x09, 0x7e}, {0x7f, 0x49, 0x49, 0x49, 0x36},
    {0x3e, 0x41, 0x41, 0x41, 0x22}, {0x7f, 0x41, 0x41, 0x22, 0x1c},
    {0x7f, 0x49, 0x49, 0x49, 0x41}, {0x7f, 0x09, 0x09, 0x09, 0x01},
    {0x3e, 0x41, 0x49, 0x49, 0x7a}, {0x7f, 0x08, 0x08, 0x08, 0x7f},
    {0x00, 0x41, 0x7f, 0x41, 0x00}, {0x20, 0x40, 0x41, 0x3f, 0x01},
    {0x7f, 0x08, 0x14, 0x22, 0x41}, {0x7f, 0x40, 0x40, 0x40, 0x40},
    {0x7f, 0x02, 0x0c, 0x02, 0x7f}, {0x7f, 0x04, 0x08, 0x10, 0x7f},
    {0x3e, 0x41, 0x41, 0x41, 0x3e}, {0x7f, 0x09, 0x09, 0x09, 0x06},
    {0x3e, 0x41, 0x51, 0x21, 0x5e}, {0x7f, 0x09, 0x19, 0x29, 0x46},
    {0x46, 0x49, 0x49, 0x49, 0x31}, {0x01, 0x01, 0x7f, 0x01, 0x01},
    {0x3f, 0x40, 0x40, 0x40, 0x3f}, {0x1f, 0x20, 0x40, 0x20, 0x1f},
    {0x7f, 0x20, 0x18, 0x20, 0x7f}, {0x63, 0x14, 0x08, 0x14, 0x63},
    {0x07, 0x08, 0x70, 0x08, 0x07}, {0x61, 0x51, 0x49, 0x45, 0x43},
};

void board_show_status(const char *text) {
    constexpr int scale = 5;
    constexpr int glyph_width = 5;
    constexpr int glyph_gap = 1;
    constexpr int glyph_height = 7;
    const size_t length = strlen(text);
    const int text_width = static_cast<int>(length) * (glyph_width + glyph_gap) * scale - glyph_gap * scale;
    const int left = (WIDTH - text_width) / 2;
    const int top = (HEIGHT - glyph_height * scale) / 2;
    memset(frame_buffer, 0, FRAME_BYTES);
    for (size_t index = 0; index < length; ++index) {
        const char character = text[index];
        if (character == ' ') continue;
        if (character < 'A' || character > 'Z') continue;
        const uint8_t *glyph = FONT[character - 'A'];
        const int glyph_left = left + static_cast<int>(index) * (glyph_width + glyph_gap) * scale;
        for (int column = 0; column < glyph_width; ++column) {
            for (int row = 0; row < glyph_height; ++row) {
                if (!(glyph[column] & (1 << row))) continue;
                for (int dx = 0; dx < scale; ++dx) {
                    for (int dy = 0; dy < scale; ++dy) {
                        frame_buffer[(top + row * scale + dy) * WIDTH + glyph_left + column * scale + dx] = 0xd7bd;
                    }
                }
            }
        }
    }
}

void board_crossfade(const uint8_t *from_bytes, const uint8_t *target_bytes, int64_t duration_us) {
    const auto *from = reinterpret_cast<const uint16_t *>(from_bytes);
    const auto *target = reinterpret_cast<const uint16_t *>(target_bytes);
    if (duration_us <= 0) {
        memcpy(frame_buffer, target, FRAME_BYTES);
        return;
    }

    // This period comes from the configured 30 MHz pixel clock and panel timings.
    constexpr int64_t frame_period_us =
        1000000LL * (WIDTH + 162 + 152 + 48) * (HEIGHT + 45 + 13 + 3) / 30000000;
    // RGB565 green has 64 levels, so more than 64 blend steps cannot add color precision.
    const int steps = static_cast<int>(std::min<int64_t>(64, std::max<int64_t>(1, duration_us / frame_period_us)));
    const int64_t started = esp_timer_get_time();
    for (int step = 1; step < steps;) {
        const int64_t scheduled = (duration_us / steps) * step + (duration_us % steps) * step / steps;
        wait_until(started + scheduled);

        const int64_t elapsed = esp_timer_get_time() - started;
        if (elapsed >= duration_us) break;
        // A full-screen PSRAM blend can take longer than one scheduled step. Skip
        // obsolete steps so the fade follows wall-clock time instead of running
        // all remaining blends late.
        while (step + 1 < steps) {
            const int next = step + 1;
            const int64_t next_scheduled =
                (duration_us / steps) * next + (duration_us % steps) * next / steps;
            if (next_scheduled > elapsed) break;
            step = next;
        }
        const int alpha = step * 256 / steps;
        const int inverse = 256 - alpha;
        for (size_t pixel = 0; pixel < static_cast<size_t>(WIDTH) * HEIGHT; ++pixel) {
            const uint16_t old_pixel = from[pixel];
            const uint16_t new_pixel = target[pixel];
            const int red = ((old_pixel >> 11) * inverse + (new_pixel >> 11) * alpha + 128) >> 8;
            const int green = (((old_pixel >> 5) & 0x3f) * inverse + ((new_pixel >> 5) & 0x3f) * alpha + 128) >> 8;
            const int blue = ((old_pixel & 0x1f) * inverse + (new_pixel & 0x1f) * alpha + 128) >> 8;
            frame_buffer[pixel] = static_cast<uint16_t>((red << 11) | (green << 5) | blue);
        }
        // Let the idle task run even when rendering takes longer than the interval.
        vTaskDelay(1);
        ++step;
    }
    wait_until(started + duration_us);
    memcpy(frame_buffer, target, FRAME_BYTES);
}

// Pin map, timing, I/O registers, and reset delays follow Waveshare's 08_Touch example.
static void write_reg(i2c_master_dev_handle_t dev, uint8_t reg, uint8_t value) {
    uint8_t bytes[] = {reg, value};
    ESP_ERROR_CHECK(i2c_master_transmit(dev, bytes, sizeof(bytes), 100));
}
esp_lcd_panel_handle_t board_init() {
    i2c_master_bus_config_t bus_config = {};
    bus_config.i2c_port = I2C_NUM_0;
    bus_config.sda_io_num = GPIO_NUM_8;
    bus_config.scl_io_num = GPIO_NUM_9;
    bus_config.clk_source = I2C_CLK_SRC_DEFAULT;
    bus_config.glitch_ignore_cnt = 7;
    i2c_master_bus_handle_t bus;
    ESP_ERROR_CHECK(i2c_new_master_bus(&bus_config, &bus));
    i2c_device_config_t dev = {};
    dev.dev_addr_length = I2C_ADDR_BIT_LEN_7;
    dev.device_address = 0x24;
    dev.scl_speed_hz = 400000;
    i2c_master_dev_handle_t io;
    ESP_ERROR_CHECK(i2c_master_bus_add_device(bus, &dev, &io));
    write_reg(io, 0x02, 0xff);
    // Keep SD deselected, select USB, hold touch in reset, and turn off the backlight.
    uint8_t output = 0xff & ~(1 << 5) & ~(1 << 2) & ~(1 << 1);
    write_reg(io, 0x03, output);
    ESP_ERROR_CHECK(gpio_set_direction(GPIO_NUM_4, GPIO_MODE_OUTPUT));
    vTaskDelay(pdMS_TO_TICKS(100));
    ESP_ERROR_CHECK(gpio_set_level(GPIO_NUM_4, 0));
    vTaskDelay(pdMS_TO_TICKS(100));
    output |= 1 << 1;
    write_reg(io, 0x03, output);
    vTaskDelay(pdMS_TO_TICKS(200));
    ESP_ERROR_CHECK(gpio_set_direction(GPIO_NUM_4, GPIO_MODE_INPUT));
    dev.device_address = 0x5d;
    ESP_ERROR_CHECK(i2c_master_bus_add_device(bus, &dev, &touch));

    esp_lcd_rgb_panel_config_t cfg = {};
    cfg.clk_src = LCD_CLK_SRC_DEFAULT;
    cfg.timings.pclk_hz = 30000000;
    cfg.timings.h_res = WIDTH;
    cfg.timings.v_res = HEIGHT;
    cfg.timings.hsync_pulse_width = 162;
    cfg.timings.hsync_back_porch = 152;
    cfg.timings.hsync_front_porch = 48;
    cfg.timings.vsync_pulse_width = 45;
    cfg.timings.vsync_back_porch = 13;
    cfg.timings.vsync_front_porch = 3;
    cfg.timings.flags.pclk_active_neg = true;
    cfg.data_width = 16;
    cfg.in_color_format = LCD_COLOR_FMT_RGB565;
    cfg.out_color_format = LCD_COLOR_FMT_RGB565;
    cfg.num_fbs = 1;
    cfg.bounce_buffer_size_px = WIDTH * 10;
    cfg.hsync_gpio_num = GPIO_NUM_46;
    cfg.vsync_gpio_num = GPIO_NUM_3;
    cfg.de_gpio_num = GPIO_NUM_5;
    cfg.pclk_gpio_num = GPIO_NUM_7;
    cfg.disp_gpio_num = GPIO_NUM_NC;
    const int pins[] = {14,38,18,17,10,39,0,45,48,47,21,1,2,42,41,40};
    memcpy(cfg.data_gpio_nums, pins, sizeof(pins));
    cfg.flags.fb_in_psram = true;
    esp_lcd_panel_handle_t panel;
    ESP_ERROR_CHECK(esp_lcd_new_rgb_panel(&cfg, &panel));
    ESP_ERROR_CHECK(esp_lcd_panel_reset(panel));
    ESP_ERROR_CHECK(esp_lcd_panel_init(panel));
    void *fb;
    ESP_ERROR_CHECK(esp_lcd_rgb_panel_get_frame_buffer(panel, 1, &fb));
    frame_buffer = static_cast<uint16_t *>(fb);
    memset(frame_buffer, 0, FRAME_BYTES);
    write_reg(io, 0x03, output | (1 << 2));
    return panel;
}
bool board_touch(uint16_t &x, bool &pressed) {
    uint8_t reg[] = {0x81, 0x4e};
    uint8_t data[6];
    if (i2c_master_transmit_receive(touch, reg, sizeof(reg), data, sizeof(data), 100) != ESP_OK) return false;
    if (!(data[0] & 0x80)) return false;
    pressed = (data[0] & 0x0f) != 0;
    x = data[2] | (data[3] << 8);
    uint8_t clear[] = {0x81, 0x4e, 0};
    return i2c_master_transmit(touch, clear, sizeof(clear), 100) == ESP_OK;
}
