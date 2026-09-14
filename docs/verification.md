# Verification

## Completed in the development workspace

- `bun run check`: no errors or warnings.
- `bun test`: 6 tests passed, with 33 assertions. Checks cover pixel encoding, fitting, EXIF orientation, invalid images, navigation, removal, settings validation, and database persistence.
- `bun run build`: SvelteKit production build passed.
- The production build ran under Bun. HTTP checks passed for token access, empty library, origin checks, photo upload, image headers, exact payload size, RGB565 color, and removal.
- Browser checks passed for upload of two files, preview selection, fit and play-order changes, saved settings after reload, removal, and mobile layout. Test images were stored in a separate temporary library.
- `pio run -d firmware`: ESP32-S3 firmware build passed with PlatformIO Espressif32 7.0.1 / ESP-IDF 6.0.1. The build reports 913,319 bytes of flash and 39,644 bytes of static RAM. Image buffers use PSRAM at runtime and are not included in that static RAM figure.

The companion checks ran on macOS under Bun 1.4.2. A Linux service start has not been tested here. The systemd file is a setup example, with paths for the owner to fill in.

[Desktop screenshot](screenshots/desktop.png) · [Mobile screenshot](screenshots/mobile.png)

## Required on the physical board

The board was not connected during development. Before normal use:

1. Set the Wi-Fi and server details, flash the firmware, and check the serial log for a connection.
2. Upload a photo with known colors. Check orientation, color order, and full-screen display.
3. Check each touch area. Confirm that a held touch produces one action and that pause stops automatic changes.
4. Let photos change at the default 10-second time. Check display stability during network transfers.
5. Stop the server during a transfer. The last complete photo must remain on screen. Restart the server and check recovery.
6. Disconnect and reconnect Wi-Fi, then restart the board. Check connection recovery and the first photo request.

No claim of a physical board test is made by the successful compiler build.
