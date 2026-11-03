/* Copyright(C) 2024-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * youtubeTvDirect.ts: Direct HLS streaming for YouTube TV via InnerTube API.
 *
 * YouTube TV's web player uses MSE/videoplayback (Server ABR), but iOS/Android TV
 * clients receive HLS manifests from the InnerTube API. This module queries the
 * InnerTube API from within the browser context (using the browser's cookies and
 * authentication) to obtain HLS manifests that can be streamed directly via the
 * native proxy with Widevine decryption.
 */
import { LOG, evaluateWithAbort } from "../utils/index.ts";
import type { Nullable } from "../types/index.ts";
import type { Page } from "puppeteer-core";

/**
 * Result of querying YouTube TV's InnerTube API for a live channel's HLS manifest.
 */
export interface YouTubeTvHlsManifest {

  /** The HLS master playlist URL. */
  hlsManifestUrl: string;
  /** The channel's playback token (vp parameter). */
  playbackToken: string;
  /** The video/channel ID. */
  videoId: string;
}

/**
 * Queries YouTube TV's InnerTube API from within the browser context to obtain
 * an HLS manifest for the currently playing live channel.
 *
 * @param page - The Puppeteer page object on the YouTube TV watch page.
 * @returns The HLS manifest information, or null if not available.
 */
export async function queryYouTubeTvHlsManifest(page: Page): Promise<Nullable<YouTubeTvHlsManifest>> {

  if(typeof page.url !== "function") {

    return null;
  }
  const url = page.url();
  const match = /\/watch\/([^?]+)\?vp=([^&]+)/.exec(url);

  if(!match) {

    LOG.debug("tuning:yttv", "Could not extract videoId and playbackToken from URL.");

    return null;
  }

  const videoId = match[1];
  const playbackToken = match[2];

  if(!videoId || !playbackToken) {

    return null;
  }
  const urlResult = { playbackToken, videoId };

  // Query InnerTube API from browser context with iOS client to get HLS manifest
  const innerTubeResult = await evaluateWithAbort(page, async (params: { videoId: string; playbackToken: string }): Promise<YouTubeTvHlsManifest | null> => {

    try {

      const response = await fetch("https://tv.youtube.com/youtubei/v1/player", {

        body: JSON.stringify({

          context: {

            client: {

              clientFormFactor: "MOBILE",
              clientName: "IOS",
              clientVersion: "19.40.3",
              deviceMake: "Apple",
              deviceModel: "iPhone15,2",
              gl: "US",
              hl: "en",
              platform: "MOBILE",
              userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148"
            }
          },
          playbackContext: {

            contentPlaybackContext: {

              html5Preference: "HTML5_PREF_WANTS",
              lactMilliseconds: "-1"
            }
          },
          videoId: params.videoId
        }),
        credentials: "include",
        headers: {

          "Content-Type": "application/json"
        },
        method: "POST"
      });

      const data = (await response.json()) as { streamingData?: { hlsManifestUrl?: string } };
      const streamingData = data.streamingData ?? {};

      if(!streamingData.hlsManifestUrl) {

        return null;
      }

      return {

        hlsManifestUrl: streamingData.hlsManifestUrl,
        playbackToken: params.playbackToken,
        videoId: params.videoId
      };
    } catch {

      return null;
    }
  }, [urlResult]);

  return innerTubeResult;
}

/**
 * Attempts to get an HLS manifest URL for a YouTube TV channel by querying the
 * InnerTube API from the browser context. This is called after navigating to
 * the watch page but before starting capture.
 *
 * @param page - The Puppeteer page object on the YouTube TV watch page.
 * @returns The HLS manifest URL if available, or null.
 */
export async function attemptDirectHlsManifest(page: Page): Promise<Nullable<string>> {

  const manifest = await queryYouTubeTvHlsManifest(page);

  if(manifest?.hlsManifestUrl) {

    LOG.info("Found HLS manifest for YouTube TV channel: %s.", manifest.hlsManifestUrl);

    return manifest.hlsManifestUrl;
  }

  return null;
}
