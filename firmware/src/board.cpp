#include "board.h"
#include "driver/i2c_master.h"
#include "driver/gpio.h"
#include "esp_lcd_panel_rgb.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include <cstring>

static i2c_master_dev_handle_t touch;
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
    memset(fb, 0, FRAME_BYTES);
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
