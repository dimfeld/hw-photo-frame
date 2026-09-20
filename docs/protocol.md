# Frame protocol

`GET /frame/next.rgb565?after=<photo UUID>&direction=previous`

Both query parameters are optional. Without `after`, the server selects the first photo in upload order, or a random photo if random play is enabled. An unknown or removed cursor starts at the first photo in sequential mode. `direction=previous` steps back in upload order and wraps. In random mode, the next choice excludes the current photo unless the library has only one photo.

When configured, send `Authorization: Bearer <FRAME_TOKEN>`.

A photo response has status `200` and these headers:

| Header | Value |
| --- | --- |
| Content-Type | application/octet-stream |
| Content-Length | 1228800 |
| X-Frame-Format | rgb565le-1024x600 |
| X-Photo-Id | UUID of the selected photo |
| X-Display-Seconds | Saved photo time, default 10 |
| X-Crossfade-Seconds | Saved crossfade time, default 2; zero disables the fade |
| Cache-Control | no-store |

The body has 1024 × 600 pixels, in rows from top to bottom and left to right. Each pixel is an unsigned little-endian 16-bit value: red in bits 15–11, green in bits 10–5, and blue in bits 4–0. There is no file header or row padding.

If the selected photo has portrait orientation and the library has another portrait photo, the body contains both photos in 511 × 600 areas. A two-pixel white divider separates them. The server selects the second photo by moving forward through upload order and wrapping if necessary. `X-Photo-Id` identifies the selected photo on the left. If there is no second portrait photo, the body contains only the selected photo with its configured fit.

An empty library returns `204`, with both timing headers and no body. The frame keeps its image and uses the display time before its next request. A failed request also leaves the image intact. The frame advances its local cursor only after it receives a complete valid image.

Each frame keeps its own cursor. Preview requests do not advance the physical frame.

Other routes:

| Route | Use |
| --- | --- |
| GET / | Library, settings, and preview |
| POST /api/photos?name=… | Upload one image as the raw request body |
| DELETE /api/photos/:id | Remove one stored photo and its prepared data |
| PUT /api/settings | JSON: seconds, crossfadeSeconds, fit (`contain` or `cover`), ordering (`sequential` or `random`) |
| GET /photo/:id?fit=contain | JPEG preview |

Requests that change data must send an `Origin` header that matches the configured app origin. Photo names are display labels, not file paths. Database queries bind user data as parameters.

The photo time must be a positive whole number of seconds. The crossfade time must be a nonnegative whole number of seconds. The upper bounds are derived from JavaScript's safe integer range after conversion to microseconds. The firmware splits long waits at the FreeRTOS tick range.
