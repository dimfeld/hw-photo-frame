idf_component_register(SRCS "main.cpp" "board.cpp" "rgb565_blend.S" INCLUDE_DIRS "." "../include"
  REQUIRES esp_lcd esp_driver_i2c esp_driver_gpio esp_wifi esp_event esp_netif nvs_flash esp_http_client esp_timer esp_new_jpeg)
