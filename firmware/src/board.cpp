#include "board.h"
#include "driver/i2c_master.h"
#include "driver/gpio.h"
#include "esp_heap_caps.h"
#include "esp_jpeg_dec.h"
#include "esp_lcd_panel_rgb.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include <algorithm>
#include <cstring>

static i2c_master_dev_handle_t touch;
static const char *TAG = "board";
static esp_lcd_panel_handle_t lcd_panel;
static uint16_t *display_buffers[2];
static uint16_t *frame_buffer;
static uint16_t *reduced_from;
static uint16_t *reduced_target;
static uint32_t completed_frames;
static portMUX_TYPE frame_lock = portMUX_INITIALIZER_UNLOCKED;

// Half-resolution sources reduce PSRAM reads while bilinear expansion avoids
// the visible blocks produced by the faster quarter-resolution experiment.
static constexpr int FADE_SCALE = 2;
static constexpr int FADE_WIDTH = WIDTH / FADE_SCALE;
static constexpr int FADE_HEIGHT = HEIGHT / FADE_SCALE;
static constexpr size_t FADE_BYTES = FADE_WIDTH * FADE_HEIGHT * sizeof(uint16_t);
alignas(16) static uint16_t blended_rows[2][FADE_WIDTH];
alignas(16) static uint16_t expanded_rows[2][WIDTH];
alignas(16) static uint16_t decoded_block[WIDTH * 16];

extern "C" void blend_rgb565_simd(uint16_t *output, const uint16_t *from,
    const uint16_t *target, size_t pixels, uint16_t alpha, uint16_t inverse);
static_assert((static_cast<size_t>(WIDTH) * HEIGHT) % 8 == 0,
    "The SIMD blend kernel requires complete eight-pixel blocks");
static_assert(WIDTH % FADE_SCALE == 0 && HEIGHT % FADE_SCALE == 0,
    "The reduced fade dimensions must divide the panel dimensions");
static_assert(FADE_WIDTH % 8 == 0,
    "Each reduced row must contain complete eight-pixel SIMD blocks");

static void wait_until(int64_t due) {
    while (esp_timer_get_time() < due) {
        const int64_t ticks = (due - esp_timer_get_time()) / (1000000 / configTICK_RATE_HZ);
        vTaskDelay(static_cast<TickType_t>(std::max<int64_t>(1, std::min<int64_t>(ticks, portMAX_DELAY - 1))));
    }
}

static bool IRAM_ATTR frame_complete(esp_lcd_panel_handle_t,
    const esp_lcd_rgb_panel_event_data_t *, void *) {
    portENTER_CRITICAL_ISR(&frame_lock);
    ++completed_frames;
    portEXIT_CRITICAL_ISR(&frame_lock);
    return false;
}

static void present_frame() {
    portENTER_CRITICAL(&frame_lock);
    const uint32_t previous_completed_frames = completed_frames;
    const esp_err_t result = esp_lcd_panel_draw_bitmap(lcd_panel, 0, 0, WIDTH, HEIGHT, frame_buffer);
    portEXIT_CRITICAL(&frame_lock);
    ESP_ERROR_CHECK(result);

    // The old front buffer is safe to reuse after the driver starts the new frame.
    uint32_t current_completed_frames;
    do {
        portENTER_CRITICAL(&frame_lock);
        current_completed_frames = completed_frames;
        portEXIT_CRITICAL(&frame_lock);
        if (current_completed_frames != previous_completed_frames) break;
        vTaskDelay(1);
    } while (true);
    frame_buffer = frame_buffer == display_buffers[0] ? display_buffers[1] : display_buffers[0];
}

static uint16_t average_rgb565(uint16_t first, uint16_t second) {
    return static_cast<uint16_t>((first & second) + (((first ^ second) & 0xf7de) >> 1));
}

static void blend_reduced_frame(uint16_t alpha, uint16_t inverse) {
    uint16_t *top = blended_rows[0];
    uint16_t *bottom = blended_rows[1];
    blend_rgb565_simd(top, reduced_from, reduced_target, FADE_WIDTH, alpha, inverse);
    for (int y = 0; y < FADE_HEIGHT; ++y) {
        if (y + 1 < FADE_HEIGHT) {
            blend_rgb565_simd(bottom, reduced_from + (y + 1) * FADE_WIDTH,
                reduced_target + (y + 1) * FADE_WIDTH, FADE_WIDTH, alpha, inverse);
        } else {
            memcpy(bottom, top, sizeof(blended_rows[0]));
        }
        for (int x = 0; x < FADE_WIDTH; ++x) {
            const int next_x = std::min(x + 1, FADE_WIDTH - 1);
            const uint16_t top_left = top[x];
            const uint16_t top_right = top[next_x];
            const uint16_t bottom_left = bottom[x];
            const uint16_t bottom_right = bottom[next_x];
            const int output_x = x * FADE_SCALE;
            expanded_rows[0][output_x] = top_left;
            expanded_rows[0][output_x + 1] = average_rgb565(top_left, top_right);
            expanded_rows[1][output_x] = average_rgb565(top_left, bottom_left);
            expanded_rows[1][output_x + 1] = average_rgb565(
                average_rgb565(top_left, top_right), average_rgb565(bottom_left, bottom_right));
        }
        memcpy(frame_buffer + y * FADE_SCALE * WIDTH, expanded_rows[0], sizeof(expanded_rows[0]));
        memcpy(frame_buffer + (y * FADE_SCALE + 1) * WIDTH, expanded_rows[1], sizeof(expanded_rows[1]));
        std::swap(top, bottom);
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
    present_frame();
}

static bool decode_jpeg(const uint8_t *jpeg, size_t length, uint8_t *output) {
    const int64_t started = esp_timer_get_time();
    jpeg_dec_config_t config = DEFAULT_JPEG_DEC_CONFIG();
    config.output_type = JPEG_PIXEL_FORMAT_RGB565_LE;
    jpeg_dec_handle_t decoder = nullptr;
    if (jpeg_dec_open(&config, &decoder) != JPEG_ERR_OK) return false;
    jpeg_dec_io_t io = {};
    jpeg_dec_header_info_t info = {};
    io.inbuf = const_cast<uint8_t *>(jpeg);
    io.inbuf_len = static_cast<int>(length);
    bool success = jpeg_dec_parse_header(decoder, &io, &info) == JPEG_ERR_OK
        && info.width == WIDTH && info.height == HEIGHT;
    int output_length = 0;
    success = success && jpeg_dec_get_outbuf_len(decoder, &output_length) == JPEG_ERR_OK
        && output_length == FRAME_BYTES;
    if (success) {
        io.outbuf = output;
        success = jpeg_dec_process(decoder, &io) == JPEG_ERR_OK;
    }
    jpeg_dec_close(decoder);
    ESP_LOGI(TAG, "JPEG timing: full decode=%lld ms bytes=%u success=%d",
        (esp_timer_get_time() - started) / 1000, static_cast<unsigned>(length), success);
    return success;
}

static bool decode_reduced_jpeg(const uint8_t *jpeg, size_t length, uint16_t *output) {
    const int64_t started = esp_timer_get_time();
    jpeg_dec_config_t config = DEFAULT_JPEG_DEC_CONFIG();
    config.output_type = JPEG_PIXEL_FORMAT_RGB565_LE;
    config.block_enable = true;
    jpeg_dec_handle_t decoder = nullptr;
    if (jpeg_dec_open(&config, &decoder) != JPEG_ERR_OK) return false;
    jpeg_dec_io_t io = {};
    jpeg_dec_header_info_t info = {};
    io.inbuf = const_cast<uint8_t *>(jpeg);
    io.inbuf_len = static_cast<int>(length);
    bool success = jpeg_dec_parse_header(decoder, &io, &info) == JPEG_ERR_OK
        && info.width == WIDTH && info.height == HEIGHT;
    int block_length = 0;
    int process_count = 0;
    success = success && jpeg_dec_get_outbuf_len(decoder, &block_length) == JPEG_ERR_OK
        && block_length > 0 && static_cast<size_t>(block_length) <= sizeof(decoded_block)
        && jpeg_dec_get_process_count(decoder, &process_count) == JPEG_ERR_OK
        && process_count > 0;
    io.outbuf = reinterpret_cast<uint8_t *>(decoded_block);
    int output_row = 0;
    for (int block = 0; success && block < process_count; ++block) {
        success = jpeg_dec_process(decoder, &io) == JPEG_ERR_OK
            && io.out_size > 0 && io.out_size % (WIDTH * sizeof(uint16_t)) == 0;
        const int rows = success ? io.out_size / (WIDTH * sizeof(uint16_t)) : 0;
        success = success && rows % 2 == 0 && output_row + rows / 2 <= FADE_HEIGHT;
        for (int y = 0; success && y < rows; y += 2, ++output_row) {
            const uint16_t *top = decoded_block + y * WIDTH;
            const uint16_t *bottom = top + WIDTH;
            uint16_t *destination = output + output_row * FADE_WIDTH;
            for (int x = 0; x < FADE_WIDTH; ++x) {
                const int source_x = x * 2;
                destination[x] = average_rgb565(
                    average_rgb565(top[source_x], top[source_x + 1]),
                    average_rgb565(bottom[source_x], bottom[source_x + 1]));
            }
        }
    }
    jpeg_dec_close(decoder);
    success = success && output_row == FADE_HEIGHT;
    ESP_LOGI(TAG, "JPEG timing: reduced decode=%lld ms bytes=%u rows=%d success=%d",
        (esp_timer_get_time() - started) / 1000, static_cast<unsigned>(length), output_row, success);
    return success;
}

bool board_show_jpeg(const uint8_t *jpeg, size_t length) {
    if (!decode_jpeg(jpeg, length, reinterpret_cast<uint8_t *>(frame_buffer))) {
        ESP_LOGE(TAG, "JPEG decode failed");
        return false;
    }
    present_frame();
    return true;
}

bool board_crossfade_jpegs(const uint8_t *from, size_t from_length,
    const uint8_t *target, size_t target_length, int64_t duration_us) {
    if (duration_us <= 0) return board_show_jpeg(target, target_length);

    // This period comes from the configured 30 MHz pixel clock and panel timings.
    constexpr int64_t frame_period_us =
        1000000LL * (WIDTH + 162 + 152 + 48) * (HEIGHT + 45 + 13 + 3) / 30000000;
    // RGB565 green has 64 levels, so more than 64 blend steps cannot add color precision.
    const int steps = static_cast<int>(std::min<int64_t>(64, std::max<int64_t>(1, duration_us / frame_period_us)));
    const int64_t preparation_started = esp_timer_get_time();
    const bool reduced_fade = reduced_from && reduced_target && steps > 1
        && decode_reduced_jpeg(from, from_length, reduced_from)
        && decode_reduced_jpeg(target, target_length, reduced_target);
    ESP_LOGI(TAG, "JPEG timing: fade preparation=%lld ms steps=%d success=%d",
        (esp_timer_get_time() - preparation_started) / 1000, steps, reduced_fade);
    if (!reduced_fade) return board_show_jpeg(target, target_length);
    const int64_t started = esp_timer_get_time();
    int presented = 0;
    int skipped = 0;
    int64_t blend_total = 0;
    int64_t blend_max = 0;
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
            ++skipped;
        }
        const int alpha = step * 256 / steps;
        const int inverse = 256 - alpha;
        const int64_t blend_started = esp_timer_get_time();
        blend_reduced_frame(static_cast<uint16_t>(alpha), static_cast<uint16_t>(inverse));
        const int64_t blend_time = esp_timer_get_time() - blend_started;
        blend_total += blend_time;
        blend_max = std::max(blend_max, blend_time);
        present_frame();
        ++presented;
        ++step;
    }
    wait_until(started + duration_us);
    ESP_LOGI(TAG, "JPEG timing: fade render=%lld ms presented=%d skipped=%d blend_avg=%lld ms blend_max=%lld ms",
        (esp_timer_get_time() - started) / 1000, presented, skipped,
        presented ? blend_total / presented / 1000 : 0, blend_max / 1000);
    return board_show_jpeg(target, target_length);
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
    cfg.num_fbs = 2;
    cfg.bounce_buffer_size_px = WIDTH * 10;
    cfg.hsync_gpio_num = GPIO_NUM_46;
    cfg.vsync_gpio_num = GPIO_NUM_3;
    cfg.de_gpio_num = GPIO_NUM_5;
    cfg.pclk_gpio_num = GPIO_NUM_7;
    cfg.disp_gpio_num = GPIO_NUM_NC;
    const int pins[] = {14,38,18,17,10,39,0,45,48,47,21,1,2,42,41,40};
    memcpy(cfg.data_gpio_nums, pins, sizeof(pins));
    cfg.flags.fb_in_psram = true;
    ESP_ERROR_CHECK(esp_lcd_new_rgb_panel(&cfg, &lcd_panel));
    esp_lcd_rgb_panel_event_callbacks_t callbacks = {};
    callbacks.on_frame_buf_complete = frame_complete;
    ESP_ERROR_CHECK(esp_lcd_rgb_panel_register_event_callbacks(lcd_panel, &callbacks, nullptr));
    ESP_ERROR_CHECK(esp_lcd_panel_reset(lcd_panel));
    ESP_ERROR_CHECK(esp_lcd_panel_init(lcd_panel));
    void *fb0;
    void *fb1;
    ESP_ERROR_CHECK(esp_lcd_rgb_panel_get_frame_buffer(lcd_panel, 2, &fb0, &fb1));
    display_buffers[0] = static_cast<uint16_t *>(fb0);
    display_buffers[1] = static_cast<uint16_t *>(fb1);
    reduced_from = static_cast<uint16_t *>(heap_caps_aligned_alloc(
        16, FADE_BYTES, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
    reduced_target = static_cast<uint16_t *>(heap_caps_aligned_alloc(
        16, FADE_BYTES, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
    if (!reduced_from || !reduced_target) {
        heap_caps_free(reduced_from);
        heap_caps_free(reduced_target);
        reduced_from = nullptr;
        reduced_target = nullptr;
        ESP_LOGW(TAG, "Reduced fade buffers unavailable; using full-resolution blending");
    }
    memset(display_buffers[0], 0, FRAME_BYTES);
    memset(display_buffers[1], 0, FRAME_BYTES);
    frame_buffer = display_buffers[1];
    write_reg(io, 0x03, output | (1 << 2));
    return lcd_panel;
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
