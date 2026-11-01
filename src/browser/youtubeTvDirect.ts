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
import type { Page } from "puppeteer-core";
import { LOG, evaluateWithAbort } from "../utils/index.ts";
import type { Nullable } from "../types/index.ts";

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
  // First, extract the playback token from the current URL
  const urlResult = await evaluateWithAbort(page, (): { videoId: string; playbackToken: string } | null => {
    const url = window.location.href;
    const match = url.match(/\/watch\/([^?]+)\?vp=([^&]+)/);
    if (!match) {
      return null;
    }
    return { videoId: match[1]!, playbackToken: match[2]! };
  });

  if (!urlResult) {
    LOG.debug("youtubeTvDirect", "Could not extract videoId and playbackToken from URL");
    return null;
  }

  const { videoId, playbackToken } = urlResult;

  // Query InnerTube API from browser context with iOS client to get HLS manifest
  const innerTubeResult = await evaluateWithAbort(page, async (params: { videoId: string; playbackToken: string }): Promise<YouTubeTvHlsManifest | null> => {
    try {
      const response = await fetch("https://tv.youtube.com/youtubei/v1/player?key=AIzaSyAO_FJ2PgBZ8JFqX4BzN-n5uVR8o8w3ZlE", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        credentials: "include",
        body: JSON.stringify({
          context: {
            client: {
              clientName: "IOS",
              clientVersion: "19.40.3",
              hl: "en",
              gl: "US",
              deviceMake: "Apple",
              deviceModel: "iPhone15,2",
              userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
              clientFormFactor: "MOBILE",
              platform: "MOBILE"
            }
          },
          videoId: params.videoId,
          playbackContext: {
            contentPlaybackContext: {
              html5Preference: "HTML5_PREF_WANTS",
              lactMilliseconds: "-1"
            }
          }
        })
      });

      const data = await response.json();
      const streamingData = data.streamingData || {};

      if (!streamingData.hlsManifestUrl) {
        return null;
      }

      return {
        hlsManifestUrl: streamingData.hlsManifestUrl,
        playbackToken: params.playbackToken,
        videoId: params.videoId
      };
    } catch (e) {
      console.warn("[PrismCast YouTube TV Direct] InnerTube request failed:", e);
      return null;
    }
  }, [urlResult]);

  return innerTubeResult;
}

/**
 * Checks if the current page is a YouTube TV watch page that supports direct HLS streaming.
 *
 * @param page - The Puppeteer page object.
 * @returns True if the page is a YouTube TV watch page with a valid playback token.
 */
export async function isYouTubeTvWatchPage(page: Page): Promise<boolean> {
  return evaluateWithAbort(page, (): boolean => {
    const url = window.location.href;
    return /^https:\/\/tv\.youtube\.com\/watch\/[^?]+\?vp=/.test(url);
  });
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
  if (manifest?.hlsManifestUrl) {
    LOG.info("youtubeTvDirect", "Found HLS manifest for YouTube TV channel: %s", manifest.hlsManifestUrl);
    return manifest.hlsManifestUrl;
  }
  return null;
}
