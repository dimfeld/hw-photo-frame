# Still — network photo frame

A picture frame for the **Waveshare ESP32-S3-Touch-LCD-7B (Type B, 1024 × 600)**, with a **Bun + SvelteKit** companion app for Linux. The default photo time is **10 seconds**.

The Linux computer stores the photos. The frame gets each photo over local Wi-Fi. A failed request leaves the last complete photo on screen. No SD card or cloud service is required.

## Start the companion app on Linux

Install Bun and the `heif-convert` command from libheif, then run:

```sh
cd companion
bun install --frozen-lockfile
cp .env.example .env
```

Edit `.env`. Set `ORIGIN` to the address you will use in your browser, for example `http://192.168.1.10:3000`. Set `PHOTO_DATA_DIR` to a directory on the Linux computer with enough free disk space. The default is `companion/data`.

```sh
bun run build
bun run start
```

Open the configured address. Select **Add photos**, then choose JPEG, PNG, WebP, TIFF, or HEIC/HEIF files. The app uses `heif-convert` for HEIC/HEIF files, then applies EXIF orientation and prepares both display options:

On Debian or Ubuntu, the command is provided by the `libheif-examples` package. The `heif-convert` executable must be available on the service user's `PATH`.

- **Whole photo:** preserve the complete photo; use black borders as needed.
- **Fill screen:** crop the edges to fill the screen.

When the selected photo is in portrait orientation, the companion finds the next portrait photo in upload order. It places both photos side by side with a two-pixel black divider. If there is no other portrait photo, it shows the selected photo by itself. Landscape photos use the previous layout.

Set the photo time, crossfade time, and play order, then select **Save settings**. The crossfade defaults to two seconds; set it to zero to switch images immediately. Click a photo to preview it. The preview does not change the photo currently on the physical frame. The frame gets settings on its next request. When paused, touch its center to resume, or its left or right side to request a photo.

The app stores originals, previews, prepared images, and settings in `photos.sqlite`. Each photo needs about 2.46 MB for its two full-frame pixel images, plus its original and JPEG previews. Portrait photos need about 1.23 MB more for the two side-by-side layouts. Stop the app before you copy the data directory for a backup. Keep the whole directory, including any SQLite WAL files. Run one app process for this library.

The web app is for a trusted home network. Anyone with access to its address can view and manage the library. Do not expose it to the public internet. `FRAME_TOKEN` can restrict the frame endpoint; it does not protect the web interface. Traffic uses local HTTP.

`BODY_SIZE_LIMIT=Infinity` removes the SvelteKit adapter's 512 KB default upload limit. You can set a limit that fits your server memory. Images are processed in memory; Sharp's own input-pixel limit still applies. Each file is uploaded and prepared separately.

See [the systemd service example](deploy/still.service) to start the app when Linux starts.

## Build and flash the frame

1. Install VS Code and the **PlatformIO IDE** extension.
2. Open the `firmware` directory as a PlatformIO project.
3. Copy `firmware/include/secrets.example.h` to `firmware/include/secrets.h`.
4. Set your 2.4 GHz Wi-Fi name and password. Set `FRAME_SERVER_URL` to the Linux server address, without a trailing slash. Do not use `localhost` here.
5. If you set `FRAME_TOKEN` on the server, enter the same value in `secrets.h`.
6. Connect the board's USB port. Select **Build**, then **Upload** in PlatformIO.
7. Open **Serial Monitor** at 115200 baud. It reports startup, Wi-Fi connection and retry events, transfer failures, pause state, and displayed photo IDs.

Command-line equivalents, from the repository root:

```sh
pio run -d firmware
pio run -d firmware -t upload
pio device monitor -b 115200
```

The build uses the example configuration if `secrets.h` is absent, so a clean checkout can compile. You must set real connection details before use. The local secrets file is excluded from source control.

If the USB port is not found, hold **BOOT**, connect USB, then release **BOOT**. After upload, press **RESET**. If necessary, set `upload_port` and `monitor_port` in `platformio.ini` to the board's device path.

Touch controls use three equal vertical parts of the screen:

- **Left:** previous photo in upload order.
- **Center:** pause or resume automatic changes.
- **Right:** next photo; uses the selected play order.

A held touch produces one action. In random mode, “previous” means the previous photo in upload order; it is not a history of random choices. Manual changes work while paused. Pause state resets when the board restarts.

At boot, the screen shows `CONNECTING TO WIFI`. After Wi-Fi connects, it shows `WIFI CONNECTED` until the first complete photo arrives. It retries every 10 seconds until it receives server settings. It then uses the saved photo time for retries. The current photo is in RAM; it does not survive a power loss. A missing or empty server does not erase a photo already on screen.

## Design and hardware notes

The companion app uses SvelteKit with `adapter-node`, run by **Bun**, plus Bun SQLite, Sharp, and the `heif-convert` CLI from libheif. Node alone cannot run this app because it uses `bun:sqlite`.

The firmware uses C++ and ESP-IDF through PlatformIO. It uses the board's RGB peripheral, PSRAM, GT911 touch controller, and I²C I/O device. It does not require LVGL. The network task owns the image buffer and display. The touch task sends FreeRTOS notification bits, so touches do not access image memory. Repeated actions during a download can merge into one pending action.

Each transfer is **1,228,800 bytes** of little-endian RGB565 data. The server does image decoding, orientation, scaling, and color conversion. The firmware checks response status, format, photo ID, length, and complete HTTP delivery before it changes the display. It blends the previous and downloaded images over the configured crossfade time. The two image buffers and LCD buffer use about 3.69 MB of PSRAM in total. The RGB driver uses Waveshare's bounce-buffer size and panel timing.

This targets **7B only**. The original 800 × 480 board has a different configuration. The I/O register protocol follows the Type B example at address `0x24`; do not replace it with a generic CH422G driver based on the family name in the wiki.

Hardware checks still need a physical board: power-on, colors, display stability during Wi-Fi transfer, touch positions, and network recovery. See [verification notes](docs/verification.md).

## Development

```sh
cd companion
bun run dev
bun run check
bun test
bun run build
```

The lockfile fixes the package versions. PlatformIO is pinned to Espressif32 7.0.1 (ESP-IDF 6.0.1). The firmware uses 16 MB flash, 8 MB octal PSRAM, and 80 MHz flash/PSRAM settings.

See [the wire protocol](docs/protocol.md) for endpoint details.

## Sources

- [Waveshare Type B example code](https://github.com/waveshareteam/ESP32-S3-Touch-LCD-7B/tree/master/examples/ESP-IDF/08_Touch): panel pins, timing, I/O registers, and touch reset sequence.
- [Waveshare Type B user guide](https://docs.waveshare.com/ESP32-S3-Touch-LCD-7B/Instructions-For-Use): board setup and USB boot steps.
- [SvelteKit adapter-node](https://svelte.dev/docs/kit/adapter-node): server build and environment settings.
- [Bun with SvelteKit](https://bun.sh/guides/ecosystem/sveltekit).
- [Sharp resize API](https://sharp.pixelplumbing.com/api-resize/).
