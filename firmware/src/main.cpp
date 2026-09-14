#include "board.h"
#if __has_include("secrets.h")
#include "secrets.h"
#else
#include "secrets.example.h"
#endif
#include <algorithm>
#include <cstring>
#include <cstdlib>
#include <string>
#include "driver/gpio.h"
#include "esp_event.h"
#include "esp_heap_caps.h"
#include "esp_http_client.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_timer.h"
#include "esp_wifi.h"
#include "nvs_flash.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

static const char *TAG = "frame";
static TaskHandle_t frame_task;
static TaskHandle_t touch_task_handle;
static constexpr uint32_t NEXT = 1, PREVIOUS = 2, PAUSE = 4, CONNECTED = 8;
static void wifi_event(void *, esp_event_base_t base, int32_t id, void *) {
    if (base == WIFI_EVENT && (id == WIFI_EVENT_STA_START || id == WIFI_EVENT_STA_DISCONNECTED)) {
        esp_wifi_connect();
    } else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
        ESP_LOGI(TAG, "Wi-Fi connected");
        xTaskNotify(frame_task, CONNECTED, eSetBits);
    }
}
static void IRAM_ATTR touch_interrupt(void *) {
    BaseType_t wake = pdFALSE;
    vTaskNotifyGiveFromISR(touch_task_handle, &wake);
    if (wake) portYIELD_FROM_ISR();
}
static void touch_task(void *) {
    bool held = false;
    for (;;) {
        ulTaskNotifyTake(pdTRUE, portMAX_DELAY);
        uint16_t x = 0;
        bool down = false;
        if (!board_touch(x, down)) continue;
        if (down && !held && x < WIDTH) {
            const uint32_t action = x < WIDTH / 3 ? PREVIOUS : (x >= WIDTH * 2 / 3 ? NEXT : PAUSE);
            xTaskNotify(frame_task, action, eSetBits);
        }
        held = down;
    }
}
struct Reply {
    std::string id, format;
    int64_t seconds = -1;
};
static esp_err_t http_event(esp_http_client_event_t *event) {
    if (event->event_id != HTTP_EVENT_ON_HEADER) return ESP_OK;
    auto &reply = *static_cast<Reply *>(event->user_data);
    if (!strcasecmp(event->header_key, "X-Photo-Id")) reply.id = event->header_value;
    if (!strcasecmp(event->header_key, "X-Frame-Format")) reply.format = event->header_value;
    if (!strcasecmp(event->header_key, "X-Display-Seconds")) {
        char *end;
        const long long value = strtoll(event->header_value, &end, 10);
        if (*end == '\0' && value >= 0 && value <= INT64_MAX / 1000000) reply.seconds = value;
    }
    return ESP_OK;
}
static bool valid_id(const std::string &id) {
    // The server uses UUIDs (36 ASCII characters).
    return id.size() == 36 && id.find_first_not_of("0123456789abcdef-") == std::string::npos;
}
static bool fetch_photo(uint8_t *pixels, const std::string &after, bool previous, Reply &reply) {
    const std::string url = std::string(FRAME_SERVER_URL) + "/frame/next.rgb565?after=" + after
        + (previous ? "&direction=previous" : "");
    esp_http_client_config_t config = {};
    config.url = url.c_str();
    config.event_handler = http_event;
    config.user_data = &reply;
    config.disable_auto_redirect = true;
    // The ESP-IDF HTTP client supplies its default network timeout.
    auto client = esp_http_client_init(&config);
    if (!client) return false;
    if (strlen(FRAME_TOKEN)) {
        const std::string auth = std::string("Bearer ") + FRAME_TOKEN;
        esp_http_client_set_header(client, "Authorization", auth.c_str());
    }
    bool complete = false;
    if (esp_http_client_open(client, 0) == ESP_OK) {
        const int64_t length = esp_http_client_fetch_headers(client);
        const int status = esp_http_client_get_status_code(client);
        if (status == 200 && length == FRAME_BYTES && valid_id(reply.id)
            && reply.format == "rgb565le-1024x600" && reply.seconds >= 0) {
            size_t received = 0;
            while (received < FRAME_BYTES) {
                const int count = esp_http_client_read(client, reinterpret_cast<char *>(pixels + received), FRAME_BYTES - received);
                if (count <= 0) break;
                received += count;
            }
            complete = received == FRAME_BYTES && esp_http_client_is_complete_data_received(client);
        }
        if (!complete) ESP_LOGW(TAG, "No complete photo received (HTTP %d); keeping current photo", status);
        // Only a valid image or the empty-library reply can change the retry time.
        if (!complete && status != 204) reply.seconds = -1;
    }
    esp_http_client_close(client);
    esp_http_client_cleanup(client);
    return complete;
}
extern "C" void app_main() {
    frame_task = xTaskGetCurrentTaskHandle();
    auto panel = board_init();
    auto pixels = static_cast<uint8_t *>(heap_caps_malloc(FRAME_BYTES, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
    ESP_ERROR_CHECK(pixels ? ESP_OK : ESP_ERR_NO_MEM);
    // Use the IDF main-task stack size for I2C calls and driver error logs.
    BaseType_t created = xTaskCreate(touch_task, "touch", CONFIG_ESP_MAIN_TASK_STACK_SIZE, nullptr, tskIDLE_PRIORITY + 1, &touch_task_handle);
    configASSERT(created == pdPASS);
    ESP_ERROR_CHECK(gpio_install_isr_service(0));
    ESP_ERROR_CHECK(gpio_set_intr_type(GPIO_NUM_4, GPIO_INTR_NEGEDGE));
    ESP_ERROR_CHECK(gpio_isr_handler_add(GPIO_NUM_4, touch_interrupt, nullptr));
    ESP_ERROR_CHECK(gpio_intr_enable(GPIO_NUM_4));
    ESP_ERROR_CHECK(nvs_flash_init());
    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());
    esp_netif_create_default_wifi_sta();
    wifi_init_config_t init = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&init));
    ESP_ERROR_CHECK(esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID, wifi_event, nullptr));
    ESP_ERROR_CHECK(esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP, wifi_event, nullptr));
    wifi_config_t wifi = {};
    static_assert(sizeof(FRAME_WIFI_SSID) <= sizeof(wifi.sta.ssid), "SSID too long");
    static_assert(sizeof(FRAME_WIFI_PASSWORD) <= sizeof(wifi.sta.password), "Password too long");
    memcpy(wifi.sta.ssid, FRAME_WIFI_SSID, sizeof(FRAME_WIFI_SSID));
    memcpy(wifi.sta.password, FRAME_WIFI_PASSWORD, sizeof(FRAME_WIFI_PASSWORD));
    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &wifi));
    ESP_ERROR_CHECK(esp_wifi_start());
    int64_t seconds = FRAME_RETRY_SECONDS;
    int64_t due = 0;
    bool paused = false;
    std::string current;
    for (;;) {
        TickType_t wait = portMAX_DELAY;
        if (!paused && seconds > 0) {
            const int64_t remaining = std::max<int64_t>(0, due - esp_timer_get_time());
            // portMAX_DELAY is reserved by FreeRTOS; longer waits are split at that boundary.
            wait = static_cast<TickType_t>(std::min<int64_t>(remaining / (1000000 / configTICK_RATE_HZ), portMAX_DELAY - 1));
        }
        uint32_t action = 0;
        xTaskNotifyWait(0, UINT32_MAX, &action, wait);
        if (action & PAUSE) {
            paused = !paused;
            ESP_LOGI(TAG, "%s", paused ? "Slideshow paused" : "Slideshow resumed");
        }
        const bool manual = action & (NEXT | PREVIOUS);
        if (!manual && (paused || (!(action & CONNECTED) && (seconds == 0 || esp_timer_get_time() < due)))) continue;
        Reply reply;
        if (fetch_photo(pixels, current, action & PREVIOUS, reply)) {
            ESP_ERROR_CHECK(esp_lcd_panel_draw_bitmap(panel, 0, 0, WIDTH, HEIGHT, pixels));
            current = reply.id;
            ESP_LOGI(TAG, "Photo displayed: %s", current.c_str());
        }
        if (reply.seconds >= 0) seconds = reply.seconds;
        due = esp_timer_get_time() + seconds * 1000000;
    }
}
