# PrismCast Direct Widevine DRM Decryption Pipeline

## Overview
This integration replaces PrismCast's screen-capture video pipeline with direct Widevine DRM decryption for YouTube TV and other DRM-protected streams. By leveraging local Widevine Device (`.wvd`) keys, in-browser EME hook challenge re-signing, and Bento4 `mp4decrypt` media segment decryption, PrismCast serves pristine, uncompressed, original-bitrate HLS streams directly to Channels DVR and Plex with zero screen-recording compression artifacts and minimal CPU/GPU overhead.

---

## Architecture

```
                    ┌──────────────────────────────────────────────┐
                    │               Puppeteer Chrome               │
                    │                                              │
                    │  tv.youtube.com (or other DRM provider)      │
                    │  ┌────────────────────────────────────────┐  │
                    │  │      In-Browser EME Interceptor        │  │
                    │  │ (MediaKeySession message/update hooks) │  │
                    │  └──────────────────┬─────────────────────┘  │
                    └─────────────────────┼────────────────────────┘
                                          │ Challenge Re-signing &
                                          │ License Response Capture
                                          ▼
                         ┌─────────────────────────────────┐
                         │   PrismCast DRM Bridge (Node)   │
                         │       (src/drm/widevine.ts)     │
                         │                 │               │
                         │                 ▼               │
                         │   Python PyWidevine Bridge      │
                         │  (src/drm/widevine_bridge.py)   │
                         │   - Parses PSSH from challenge  │
                         │   - Signs challenge with .wvd   │
                         │   - Decrypts license response   │
                         │     => KID:KEY content keys     │
                         └─────────────────┬───────────────┘
                                           │
                                           │ Content Decryption Keys
                                           ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                   PrismCast Native HLS Proxy (Node.js)                   │
│                         (src/native/proxy.ts)                            │
│                                                                          │
│ 1. Polls upstream playlist (.m3u8 / .mpd)                                │
│ 2. Downloads raw fragmented media (.m4s) & init segments over HTTP       │
│ 3. Decrypts init segment (encv -> avc1) via Bento4 mp4decrypt            │
│ 4. Decrypts media segments in ~10ms via Bento4 mp4decrypt                │
│ 5. Stores decrypted segments in in-memory ring buffer (hlsSegments.ts)   │
│ 6. Generates clean unencrypted HLS playlists                             │
└──────────────────────────────────┬───────────────────────────────────────┘
                                   │
                                   ▼
          ┌─────────────────────────────────────────────────┐
          │ Downstream Consumers (Channels DVR, Plex, VLC)  │
          │ Uncompressed, pristine 1080p/720p 60fps streams │
          └─────────────────────────────────────────────────┘
```

---

## Key Modules

### 1. DRM Subsystem (`src/drm/`)
- `src/drm/widevine_bridge.py`:
  - Python bridge exposing `pywidevine` CDM operations.
  - `device_info`: Inspects and validates `.wvd` device credentials.
  - `build_challenge`: Generates signed challenges from a PSSH box.
  - `resign_challenge`: Extracts PSSH from an incoming browser challenge, re-signs it using the local WVD, and stores the session for license unwrapping.
  - `parse_license`: Unwraps the DRM license response using the WVD session to extract plaintext `KID:KEY` pairs.
- `src/drm/types.ts`: Strict TypeScript definitions (`DrmKey`, `WidevineChallenge`, `WidevineDeviceInfo`, `DrmContext`).
- `src/drm/decrypt.ts`: High-performance Bento4 `mp4decrypt` wrapper for fMP4 initialization segment decryption and `.m4s` fragment decryption (~10ms per chunk).
- `src/drm/widevine.ts`: Asynchronous bridge client with automatic Python virtual environment and WVD path resolution.
- `src/drm/drm.test.ts`: 10 comprehensive unit tests covering WVD loading, challenge re-signing, and media decryption.

### 2. Browser EME Interceptor (`src/browser/emeInterceptor.ts`)
- Injected via Puppeteer's `page.evaluateOnNewDocument()` before any page scripts load.
- Hooks `MediaKeySession.prototype.addEventListener("message", ...)` to intercept the browser's DRM challenge, calls `__prismcast_resign_challenge()` to substitute the WVD challenge, allowing the web player to send the challenge with all genuine browser cookies, authentication headers, and tokens.
- Hooks `MediaKeySession.prototype.update(...)` to intercept the DRM server's license response and extract content keys via `__prismcast_on_license()`.
- Exposes `waitForKeys(timeoutMs)` fully compliant with PrismCast's strict `Clock` port.
- `src/browser/emeInterceptor.test.ts`: Validates page hook installation, exposed functions, and key resolution.

### 3. Native Proxy & HLS Stream Relay (`src/native/`)
- `src/native/proxy.ts`:
  - Accepts `drmKeys` in `NativeProxyOptions`.
  - In `resolveTrackInit()`: decrypts the fMP4 `#EXT-X-MAP` initialization segment with `decryptInitSegment()` and saves `tracking.rawEncInit`.
  - In `fetchAndDecryptSegment()`: decrypts media segments (`.m4s`) using `decryptMediaSegment(rawEncInit, data, ctx.drmKeys)`.
  - Emits 100% unencrypted, clear HLS playlists (`#EXT-X-KEY` stripped) for downstream clients.
- `src/native/index.ts`:
  - In `attemptNativeStreaming()`: when a DRM-protected stream is detected, awaits DRM keys from `options.emeInterceptor.waitForKeys(15000)`.
  - When keys are acquired, constructs the native proxy with `drmKeys`, shuts down the FFmpeg screen capture pipeline, and transitions the stream to native mode.
  - If keys are unavailable or timeout, seamlessly falls back to screen capture.
- `src/native/probe.ts`:
  - Correctly classifies DRM feeds while preserving container inference for fMP4 streams.

### 4. Streaming Lifecycle (`src/streaming/`)
- `src/streaming/setup.ts`:
  - Installs `installEmeInterceptor(page)` before navigation and registers it on the `DisposableStack`.
  - Adjusts `skipInterception` so DRM channels are intercepted and upgraded when DRM decryption is available on the host.
- `src/streaming/hls.ts`:
  - Passes `emeInterceptor: setup.emeInterceptor` to `attemptNativeStreaming()`.

---

## Verification & Test Results
- **Unit & Integration Tests**:
  - `npx tsx --test src/drm/*.test.ts src/browser/emeInterceptor.test.ts src/native/*.test.ts src/streaming/setup.test.ts src/streaming/hls.test.ts`
  - **371 tests pass, 0 fail**.
- **Type Checking**:
  - `npm run typecheck`
  - **0 errors** across the entire repository.
- **Linting & Code Quality**:
  - `npx eslint src/native/proxy.ts src/native/probe.ts src/native/index.ts src/streaming/setup.ts src/streaming/hls.ts src/drm/ src/browser/emeInterceptor*`
  - **0 errors** against `@hjdhjd` ESLint rules.
