#pragma once
#define FRAME_WIFI_SSID "YOUR_2_4_GHZ_WIFI"
#define FRAME_WIFI_PASSWORD "YOUR_WIFI_PASSWORD"
#define FRAME_SERVER_URL "http://192.168.1.10:3000"
#define FRAME_TOKEN ""
// Choose the retry time for the first request, in seconds.
// Zero means wait for a touch or a Wi-Fi connection event.
// After a server response, the saved slideshow time becomes the retry time.
#define FRAME_RETRY_SECONDS 10
