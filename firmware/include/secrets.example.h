#pragma once
#define FRAME_WIFI_SSID "YOUR_2_4_GHZ_WIFI"
#define FRAME_WIFI_PASSWORD "YOUR_WIFI_PASSWORD"
#define FRAME_SERVER_URL "http://192.168.1.10:3000"
#define FRAME_TOKEN ""
// Choose the retry time for the first request, in seconds.
// Zero means wait for a touch or a Wi-Fi connection event.
// After a server response, the saved slideshow time becomes the retry time.
#define FRAME_RETRY_SECONDS 10

// Automatic backlight brightness is off until the LDR divider is installed and
// calibrated. Connect the LDR from 3V3 to GPIO6 and a fixed resistor from GPIO6
// to GND. Start with a resistor close to the LDR's resistance in normal room
// light. The ADC reading must increase as the room becomes brighter.
#define FRAME_AUTO_BRIGHTNESS 0

// To enable the feature, set FRAME_AUTO_BRIGHTNESS to 1. Temporarily use 0 and
// 4095 below, watch the "Ambient light raw" serial messages in the darkest and
// brightest expected conditions, then replace these values with those readings.
#define FRAME_LDR_DARK_RAW 0
#define FRAME_LDR_BRIGHT_RAW 4095
