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
  LOG.debug("tuning:yttv", "Current page URL for InnerTube query: %s.", url);
  
  // Try multiple URL patterns to extract videoId and playbackToken
  let videoId: string | null = null;
  let playbackToken: string | null = null;
  
  // Pattern 1: /watch/VIDEO_ID?vp=PLAYBACK_TOKEN
  let match = /\/watch\/([^?]+)\?vp=([^&]+)/.exec(url);
  if(match) {
    videoId = match[1] ?? null;
    playbackToken = match[2] ?? null;
  }
  
  // Pattern 2: /live/VIDEO_ID?vp=PLAYBACK_TOKEN (newer format)
  if(!videoId) {
    match = /\/live\/([^?]+)\?vp=([^&]+)/.exec(url);
    if(match) {
      videoId = match[1] ?? null;
      playbackToken = match[2] ?? null;
    }
  }
  
  // Pattern 3: Try to extract from page content (window.ytcfg or similar)
  if(!videoId || !playbackToken) {
    try {
      const pageData = await evaluateWithAbort(page, (): { videoId: string | null; playbackToken: string | null } => {
        // Try to find videoId and vp in various places
        let foundVideoId: string | null = null;
        let foundPlaybackToken: string | null = null;
        
        // Check window.ytcfg
        const win = window as { ytcfg?: { data?: { VIDEO_ID?: string; video_id?: string; VP?: string; vp?: string } }; ytInitialData?: { contents?: unknown } };
        if(win.ytcfg && win.ytcfg.data) {
          foundVideoId = win.ytcfg.data.VIDEO_ID ?? win.ytcfg.data.video_id ?? null;
          foundPlaybackToken = win.ytcfg.data.VP ?? win.ytcfg.data.vp ?? null;
        }
        
        // Check ytInitialData
        if(!foundVideoId && win.ytInitialData) {
          const contents = win.ytInitialData.contents;
          if(contents) {
            const jsonStr = JSON.stringify(contents);
            const videoIdMatch = jsonStr.match(/"videoId"\s*:\s*"([^"]+)"/);
            const vpMatch = jsonStr.match(/"vp"\s*:\s*"([^"]+)"/);
            if(videoIdMatch) foundVideoId = videoIdMatch[1] ?? null;
            if(vpMatch) foundPlaybackToken = vpMatch[1] ?? null;
          }
        }
        
        // Check URL parameters as last resort
        if(!foundVideoId) {
          const urlParams = new URLSearchParams(window.location.search);
          foundVideoId = urlParams.get("v") ?? urlParams.get("video_id") ?? null;
          foundPlaybackToken = urlParams.get("vp") ?? null;
        }
        
        return { videoId: foundVideoId, playbackToken: foundPlaybackToken };
      }, undefined, { timeoutMs: 5000 });
      
      if(pageData.videoId) videoId = pageData.videoId;
      if(pageData.playbackToken) playbackToken = pageData.playbackToken;
    } catch {
      // Ignore extraction errors
    }
  }

  if(!videoId || !playbackToken) {
    LOG.debug("tuning:yttv", "Could not extract videoId and playbackToken from URL or page. URL was: %s, videoId: %s, playbackToken: %s.", url, videoId, playbackToken);
    return null;
  }
  
  LOG.debug("tuning:yttv", "Extracted videoId: %s, playbackToken: %s.", videoId, playbackToken);
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

        LOG.debug("tuning:yttv", "InnerTube response missing hlsManifestUrl. Response: %s.", JSON.stringify(data).slice(0, 500));

        return null;
      }

      return {

        hlsManifestUrl: streamingData.hlsManifestUrl,
        playbackToken: params.playbackToken,
        videoId: params.videoId
      };
    } catch(error) {

      LOG.debug("tuning:yttv", "InnerTube API fetch error: %s.", String(error));

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