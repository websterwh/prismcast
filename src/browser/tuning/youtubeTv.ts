/* Copyright(C) 2024-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * youtubeTv.ts: YouTube TV EPG grid channel selection strategy.
 */
import type { ChannelSelectionProfile, ChannelSelectorResult, DiscoveredChannel, Nullable, ProviderModule } from "../../types/index.ts";
import { LOG, delay, evaluateWithAbort, formatError } from "../../utils/index.ts";
import { attemptGuideRecovery, createEmptyDiscoveryGuard, logAvailableChannels } from "./shared.ts";
import { createProviderChannelCache, dedupeCacheEntries } from "./cache.ts";
import { CONFIG } from "../../config/index.ts";
import type { Page } from "puppeteer-core";
import type { PersistedLineupChannel } from "../../config/providerLineups.ts";
import { systemClock } from "homebridge-plugin-utils";

// Base URL for YouTube TV watch page navigation.
const YOUTUBE_TV_BASE_URL = "https://tv.youtube.com";

// Internal cache entry combining discovery metadata and tuning data. The discovered field provides the API-facing DiscoveredChannel (name, channelSelector,
// affiliate), and the watchUrl provides the direct navigation target for tuning. Both are populated from the same discoverGuideChannels() result, ensuring a single
// source of truth for "what channels exist" and "how to tune to them."
interface YttvChannelEntry {

  discovered: DiscoveredChannel;
  watchUrl: string;
}

// Unified channel cache for YouTube TV. Maps lowercased guide names (e.g., "cnn", "nbc 5", "espn") to their combined discovery and tuning data. Populated during
// the first tune (when the strategy enumerates all ~256 channels from the non-virtualized EPG grid) or the first discovery call. Both tuning (via findWatchUrl) and
// discovery (via getCachedChannels / discoverYttvChannels) read from this single cache. Cleared on browser disconnect via clearYttvCache().
const yttvCache = createProviderChannelCache<YttvChannelEntry>((entry) => entry.discovered);

// Recovery guard for the degraded guide state where the grid container renders but channel entries are not populated, which stale browser session state -
// service workers and cached SPA code after a Chrome update - produces. The guard counts the empty loads and signals when clearing YTTV site data (service
// workers and cache storage) via CDP is warranted. Reset on any successful discovery (> 0 channels found) and on browser restart (via clearYttvCache).
const emptyDiscoveryGuard = createEmptyDiscoveryGuard("YouTube TV");

// Known alternate channel names for affiliates that vary by market. CW appears as "WGN" in some markets. PBS affiliates appear under local call letters (e.g.,
// WTTW, KQED) or branded names (e.g., "Cascade PBS", "Lakeshore PBS") rather than "PBS", so we list the major market call letters and branded names to cover most
// users. Each alternate is tried after the primary name fails both exact and prefix+digit matching. Users in smaller markets override via custom channel entries with
// their local call letters as the channelSelector.
const CHANNEL_ALTERNATES: Record<string, string[]> = {

  "cw": ["WGN"],
  "pbs": [
    "Cascade PBS", "GBH", "KAET", "KBTC", "KCET", "KCTS", "KERA", "KLCS", "KOCE", "KPBS", "KQED", "KRMA", "KUHT", "KVIE", "Lakeshore PBS", "MPT", "NJ PBS",
    "THIRTEEN", "TPT", "WETA", "WGBH", "WHYY", "WLIW", "WNED", "WNET", "WNIT", "WPBA", "WPBT", "WTTW", "WTVS", "WXEL"
  ]
};

/**
 * Looks up a watch URL in the unified cache using three-tier matching logic. The tiers are tried in order for each name in the candidate list (primary
 * channelSelector first, then any CHANNEL_ALTERNATES):
 *
 * 1. Exact match: cache key equals the lowercased name (e.g., "cnn" matches "cnn").
 * 2. Prefix+digit: cache key starts with the name followed by a space and a digit. Catches local affiliates displayed as "{Network} {Number}" (e.g., "nbc 5",
 *    "abc 7") while excluding unrelated channels that share the prefix (e.g., "nbc sports").
 * 3. Parenthetical suffix: cache key starts with the name followed by " (". Catches timezone/region variants like "magnolia network (pacific)".
 *
 * When a non-exact match succeeds, the result is also cached under the primary channelSelector key for O(1) lookup on subsequent calls. This function backs the
 * resolveDirectUrl hook via the async resolveYttvDirectUrl wrapper - after the first tune populates the cache via channel discovery, every subsequent YTTV tune
 * resolves here without loading the guide page.
 * @param channelName - The channelSelector value (e.g., "CNN", "NBC", "CW").
 * @returns The full watch URL or null if no match is found.
 */
function findWatchUrl(channelName: string): Nullable<string> {

  const lower = channelName.toLowerCase();

  // Build the candidate list: primary name first, then any known alternates for markets where the affiliate uses a different name.
  const alternates = CHANNEL_ALTERNATES[lower];

  const namesToTry = alternates ? [ lower, ...alternates.map((a) => a.toLowerCase()) ] : [lower];

  for(const name of namesToTry) {

    // Tier 1: Exact match.
    const exact = yttvCache.map.get(name);

    if(exact) {

      // Cache under the primary channelSelector key if we matched via an alternate name, so subsequent lookups are O(1).
      if(name !== lower) {

        yttvCache.map.set(lower, exact);
      }

      return exact.watchUrl;
    }

    // Tier 2: Prefix+digit match for local affiliates. Iterate all cache entries to find one whose key starts with "{name} " followed by a digit, matching the
    // "{Network} {Number}" pattern (e.g., "nbc 5", "abc 7") while excluding unrelated channels that share the prefix (e.g., "nbc sports"). The 48 and 57 bounds
    // are the ASCII code points for '0' and '9', so the charCodeAt comparison tests that the character after the space is a digit.
    for(const [ key, entry ] of yttvCache.map) {

      if(key.startsWith(name + " ") && (key.length > name.length + 1) && (key.charCodeAt(name.length + 1) >= 48) && (key.charCodeAt(name.length + 1) <= 57)) {

        yttvCache.map.set(lower, entry);

        return entry.watchUrl;
      }
    }

    // Tier 3: Parenthetical suffix match for timezone/region variants. Find a cache entry whose key starts with "{name} (" to catch channels like
    // "magnolia network (pacific)" or "the filipino channel (pacific)".
    for(const [ key, entry ] of yttvCache.map) {

      if(key.startsWith(name + " (")) {

        yttvCache.map.set(lower, entry);

        return entry.watchUrl;
      }
    }
  }

  return null;
}

/**
 * Clears all YouTube TV caches: the unified channel cache and the empty discovery counter. Called by clearChannelSelectionCaches() in the coordinator when the
 * browser restarts, since a fresh browser session resolves the degraded guide state that the counter tracks.
 */
function clearYttvCache(): void {

  emptyDiscoveryGuard.reset();
  yttvCache.clear();
}

/**
 * Returns YouTube TV's durable lineup for the persisted lineup store: each cached channel's identity paired with its watch URL. The URL is built from the guide's
 * own watch path and carries no session state, so it survives a restart and lets a boot whose guide read failed still tune directly. The three-tier matching above
 * files one entry object under several alias keys, so the entries are reduced to one occurrence per object before projection.
 * @returns The durable lineup rows, or null when the cache is cold.
 */
function exportYttvLineup(): Nullable<PersistedLineupChannel[]> {

  if(yttvCache.map.size === 0) {

    return null;
  }

  return dedupeCacheEntries(yttvCache.map.values()).map((entry) => ({

    channelSelector: entry.discovered.channelSelector,
    name: entry.discovered.name,
    watchUrl: entry.watchUrl
  }));
}

// Constants for YouTube TV virtualized guide scrolling.
const YTTV_SCROLL_STEP_PX = 250;
const YTTV_SCROLL_DELAY_MS = 250;
const YTTV_MAX_SCROLL_STEPS = 150;
const YTTV_MAX_DISCOVERY_DURATION_MS = 45000;

// Raw guide row as extracted from the rendered EPG grid.
interface RawYttvChannel {

  name: string;
  watchPath: string;
}

// Result of one incremental scroll step evaluate call.
interface YttvScrollStepResult {

  channels: RawYttvChannel[];
  clientHeight: number;
  newScrollTop: number;
  oldScrollTop: number;
  scrollHeight: number;
}

// Broadcast network names that have local affiliates displayed as "{Network} {Number}" (e.g., "NBC 5", "ABC 7") in the YouTube TV guide. Used to constrain
// prefix+digit affiliate detection to actual broadcast networks and avoid false positives like "ESPN 2" or "Fox Sports 1".
const YTTV_BROADCAST_NETWORKS = new Set([ "abc", "cbs", "cw", "fox", "nbc", "pbs" ]);

// Pattern for detecting local affiliate channels displayed as "{Network} {Number}" (e.g., "NBC 5", "ABC 7"). The prefix is validated against
// YTTV_BROADCAST_NETWORKS before tagging as an affiliate.
const YTTV_AFFILIATE_PATTERN = /^(.+?) \d/;

/**
 * Builds a reverse lookup from alternate names to their parent network for affiliate detection.
 * @returns Map from lowercased alternate name to uppercase network name.
 */
function buildAlternateToNetworkMap(): Map<string, string> {

  const alternateToNetwork = new Map<string, string>();

  for(const [ network, alts ] of Object.entries(CHANNEL_ALTERNATES)) {

    for(const alt of alts) {

      alternateToNetwork.set(alt.toLowerCase(), network.toUpperCase());
    }
  }

  return alternateToNetwork;
}

/**
 * Adds a raw channel entry to the unified channel cache with local affiliate tagging.
 * @param ch - Raw channel name and watch path.
 * @param alternateToNetwork - Reverse lookup map from alternate names to parent networks.
 */
function addRawChannelToCache(ch: RawYttvChannel, alternateToNetwork: Map<string, string>): void {

  const entry: DiscoveredChannel = { channelSelector: ch.name, name: ch.name };
  const prefixMatch = YTTV_AFFILIATE_PATTERN.exec(ch.name)?.[1];

  if(prefixMatch && YTTV_BROADCAST_NETWORKS.has(prefixMatch.toLowerCase())) {

    entry.affiliate = prefixMatch.toUpperCase();
    entry.channelSelector = entry.affiliate;
  } else {

    const altNetwork = alternateToNetwork.get(ch.name.toLowerCase());

    if(altNetwork) {

      entry.affiliate = altNetwork;
      entry.channelSelector = altNetwork;
    }
  }

  yttvCache.map.set(ch.name.toLowerCase(), { discovered: entry, watchUrl: YOUTUBE_TV_BASE_URL + "/" + ch.watchPath });
}

/**
 * Traverses the virtualized YouTube TV guide grid via incremental scrolling. Each step reads rendered thumbnail endpoints, checks for streamable watch URLs,
 * and increments scrollTop. When targetChannel is specified, checks for a match at each step and exits early as soon as the target channel is found.
 * @param page - The Puppeteer page object.
 * @param targetChannel - Optional channelSelector to locate with early exit.
 * @returns Object with all accumulated channels and the matched watch URL if found.
 */
async function scrollAndDiscoverGuideChannels(
  page: Page,
  targetChannel?: string
): Promise<{ allChannels: RawYttvChannel[]; completedWalk: boolean; matchedWatchUrl: Nullable<string> }> {

  const collected = new Map<string, RawYttvChannel>();
  const alternateToNetwork = targetChannel ? buildAlternateToNetworkMap() : null;
  const startTime = systemClock.now();
  let consecutiveNoNewChannels = 0;
  let completed = false;

  for(let step = 0; step < YTTV_MAX_SCROLL_STEPS; step++) {

    // eslint-disable-next-line no-await-in-loop
    const evalResult = await evaluateWithAbort(page, (stepPx: number): YttvScrollStepResult | RawYttvChannel[] => {

      const rawChannels: RawYttvChannel[] = [];

      for(const thumb of Array.from(document.querySelectorAll("ytu-endpoint.tenx-thumb[aria-label]"))) {

        const label = thumb.getAttribute("aria-label") ?? "";

        if(!label.startsWith("watch ")) {

          continue;
        }

        const anchor = thumb.querySelector("a");
        const href = anchor?.getAttribute("href") ?? "";

        if(href.startsWith("watch/")) {

          rawChannels.push({ name: label.slice(6), watchPath: href });
        }
      }

      const byId = document.querySelector("#id-bottom-main-content");
      const byClass = document.querySelector(".bottom-main-content");
      let container: HTMLElement | null = (byId instanceof HTMLElement) ? byId : ((byClass instanceof HTMLElement) ? byClass : null);

      if(!container) {

        const row = document.querySelector("ytu-epg-row");

        if(row) {

          let parent = row.parentElement;

          while(parent) {

            if(parent.scrollHeight > parent.clientHeight) {

              container = parent;

              break;
            }

            parent = parent.parentElement;
          }
        }
      }

      container ??= (document.scrollingElement instanceof HTMLElement) ? document.scrollingElement : document.documentElement;

      const oldScrollTop = container.scrollTop;
      const clientHeight = container.clientHeight;
      const scrollHeight = container.scrollHeight;

      container.scrollTop = oldScrollTop + stepPx;
      const newScrollTop = container.scrollTop;

      return {

        channels: rawChannels,
        clientHeight,
        newScrollTop,
        oldScrollTop,
        scrollHeight
      };
    }, [YTTV_SCROLL_STEP_PX]);

    // Test double compatibility: if evaluate returned an array directly.
    if(Array.isArray(evalResult)) {

      for(const ch of evalResult) {

        collected.set(ch.name.toLowerCase(), ch);

        if(alternateToNetwork) {

          addRawChannelToCache(ch, alternateToNetwork);
        }
      }

      const matched = targetChannel ? findWatchUrl(targetChannel) : null;

      return { allChannels: Array.from(collected.values()), completedWalk: true, matchedWatchUrl: matched };
    }

    const { channels, clientHeight, newScrollTop, oldScrollTop, scrollHeight } = evalResult;
    const prevCount = collected.size;

    for(const ch of channels) {

      collected.set(ch.name.toLowerCase(), ch);

      if(alternateToNetwork) {

        addRawChannelToCache(ch, alternateToNetwork);
      }
    }

    if(collected.size === prevCount) {

      consecutiveNoNewChannels++;
    } else {

      consecutiveNoNewChannels = 0;
    }

    if(targetChannel) {

      const matched = findWatchUrl(targetChannel);

      if(matched) {

        LOG.debug("tuning:yttv", "Found target channel %s at step %d (collected %d channels).", targetChannel, step, collected.size);

        return { allChannels: Array.from(collected.values()), completedWalk: false, matchedWatchUrl: matched };
      }
    }

    const atBottom = (oldScrollTop + clientHeight >= scrollHeight - 5) || (newScrollTop === oldScrollTop);
    const stallingAtBottom = (consecutiveNoNewChannels >= 4) && (oldScrollTop + clientHeight >= scrollHeight * 0.9);
    const timedOut = (systemClock.now() - startTime) >= YTTV_MAX_DISCOVERY_DURATION_MS;

    if(atBottom || stallingAtBottom || timedOut) {

      completed = atBottom || stallingAtBottom;

      break;
    }

    // eslint-disable-next-line no-await-in-loop
    await delay(YTTV_SCROLL_DELAY_MS);
  }

  const matched = targetChannel ? findWatchUrl(targetChannel) : null;

  return { allChannels: Array.from(collected.values()), completedWalk: completed, matchedWatchUrl: matched };
}

/**
 * Discovers all channels from the YouTube TV EPG grid by scrolling through the virtualized guide.
 * @param page - The Puppeteer page object positioned on the YouTube TV live guide.
 * @returns Array of discovered channel names and watch paths.
 */
async function discoverGuideChannels(page: Page): Promise<RawYttvChannel[]> {

  const result = await scrollAndDiscoverGuideChannels(page);

  return result.allChannels;
}

/**
 * Scans the YouTube TV guide grid for a target channel, stopping as soon as the channel is matched.
 * @param page - The Puppeteer page object positioned on the YouTube TV live guide.
 * @param channelName - The target channel selector string.
 * @returns All channels discovered during the scan and the resolved watch URL if matched.
 */
async function scanGuideForChannel(
  page: Page,
  channelName: string
): Promise<{ allChannels: RawYttvChannel[]; completedWalk: boolean; watchUrl: Nullable<string> }> {

  const result = await scrollAndDiscoverGuideChannels(page, channelName);

  return { allChannels: result.allChannels, completedWalk: result.completedWalk, watchUrl: result.matchedWatchUrl };
}

/**
 * Populates the unified channel cache from raw guide channel data. For each channel, builds a DiscoveredChannel with affiliate detection and pairs it with the
 * full watch URL. Detects affiliates via prefix+digit pattern constrained to known broadcast networks, and CHANNEL_ALTERNATES entries for affiliates with distinct
 * names. Marks the cache complete once populated.
 * @param rawChannels - Array of channel names and watch paths from discoverGuideChannels().
 */
function populateYttvChannelCache(rawChannels: RawYttvChannel[]): void {

  yttvCache.clear();

  const alternateToNetwork = buildAlternateToNetworkMap();

  for(const ch of rawChannels) {

    addRawChannelToCache(ch, alternateToNetwork);
  }

  yttvCache.markComplete();
}

/**
 * YouTube TV grid strategy: locates a channel from the virtualized EPG grid at tv.youtube.com/live by incrementally scrolling the scroll container
 * (#id-bottom-main-content), checking for matches at each step, and navigating directly to the matched watch URL once found.
 *
 * The selection process:
 * 1. Wait for ytu-epg-row elements to confirm the guide grid has loaded.
 * 2. Discover all channels: extract aria-label names and watch/ hrefs from every thumbnail endpoint.
 * 3. If no channels are discovered (degraded guide state), attempt recovery by clearing cached site data via CDP and reloading.
 * 4. Populate the unified channel cache with all discovered channels (discovery metadata + watch URLs).
 * 5. Look up the target channel using tiered matching (exact, prefix+digit, parenthetical, alternates) against the cache.
 * 6. Navigate to the matched watch URL via page.goto().
 * @param page - The Puppeteer page object.
 * @param profile - The resolved site profile with a non-null channelSelector (channel name, e.g., "CNN", "ESPN", "NBC").
 * @returns Result object with success status and optional failure reason.
 */
async function youtubeGridStrategy(page: Page, profile: ChannelSelectionProfile): Promise<ChannelSelectorResult> {

  const channelName = profile.channelSelector;

  // Wait for the EPG grid to render. Once the first row exists, guide elements are queryable.
  try {

    await page.waitForSelector("ytu-epg-row", { timeout: CONFIG.streaming.videoTimeout });
  } catch {

    return { guideUnavailable: true, reason: "YouTube TV guide grid did not load.", success: false };
  }

  // Scan guide for the target channel, exiting early as soon as the channel is matched.
  const scanResult = await scanGuideForChannel(page, channelName);
  let allChannels = scanResult.allChannels;
  const completedWalk = scanResult.completedWalk;
  let watchUrl = scanResult.watchUrl;

  // If the guide loaded but no channels were discovered, the guide is in a degraded state - the grid container rendered but channel entries were not populated.
  // This can happen when stale browser session state (service workers, cached SPA code) becomes inconsistent after a Chrome update. Track consecutive occurrences
  // and attempt recovery by clearing cached site data once the threshold is reached.
  if(allChannels.length === 0) {

    if(emptyDiscoveryGuard.recordEmpty()) {

      allChannels = await attemptGuideRecovery(page, {

        discover: discoverGuideChannels,
        origin: YOUTUBE_TV_BASE_URL,
        providerName: "YouTube TV",
        reloadUrl: YOUTUBE_TV_BASE_URL + "/live",
        storageTypes: "cache_storage,service_workers",
        waitSelector: "ytu-epg-row"
      });

      if(allChannels.length > 0) {

        populateYttvChannelCache(allChannels);
        watchUrl = findWatchUrl(channelName);
      }
    }
  }

  // If we still have no channels after the initial discovery and any recovery attempt, there is nothing to search or cache. This error message is deliberately
  // distinct from the name-mismatch "not found" message below so users can immediately tell the guide itself is broken rather than suspecting a wrong channel name.
  if(allChannels.length === 0) {

    return { reason: "YouTube TV guide is empty - no channels were discovered.", success: false };
  }

  // Successful discovery - reset the consecutive empty counter.
  emptyDiscoveryGuard.reset();

  // If the walk was complete, populate the unified cache so cached() reflects the fresh guide read and dropped channels are evicted.
  if(completedWalk) {

    populateYttvChannelCache(allChannels);
  }

  // If the channel was not matched during the walk, check the cache once more in case it was already known.
  watchUrl ??= findWatchUrl(channelName);

  if(!watchUrl) {

    // Target channel not found even after scanning the guide. Populate full cache with everything found and log diagnostics.
    populateYttvChannelCache(allChannels);

    // Channel not found. Log available channels as a diagnostic to help users identify their market's channel names and create user-defined channels with the
    // correct channelSelector value. Build additional known names from CHANNEL_ALTERNATES values so they are also filtered out of the diagnostic list.
    const additionalKnownNames: string[] = [];

    for(const alts of Object.values(CHANNEL_ALTERNATES)) {

      for(const alt of alts) {

        additionalKnownNames.push(alt);
      }
    }

    logAvailableChannels({

      additionalKnownNames,
      availableChannels: allChannels.map((ch) => ch.name).sort(),
      channelName,
      guideUrl: "https://tv.youtube.com/live",
      presetSuffix: "-yttv",
      providerName: "YouTube TV"
    });

    return { reason: "Channel \"" + channelName + "\" not found in YouTube TV guide.", success: false };
  }

  LOG.debug("tuning:yttv", "Navigating to YouTube TV watch URL for %s.", channelName);

  try {

    await page.goto(watchUrl, { timeout: CONFIG.streaming.navigationTimeout, waitUntil: "load" });
  } catch(error) {

    return { reason: "Failed to navigate to YouTube TV watch page: " + formatError(error) + ".", success: false };
  }

  return { success: true };
}

/**
 * Async wrapper around findWatchUrl for the ChannelStrategyEntry.resolveDirectUrl contract. The page parameter is unused because YTTV watch URLs are resolved
 * purely from the in-memory cache populated during the initial guide page discovery.
 * @param channelSelector - The channel selector string (e.g., "CNN", "ESPN", "NBC").
 * @param _page - Unused. Present to satisfy the async resolveDirectUrl signature.
 * @returns The cached watch URL or null.
 */
async function resolveYttvDirectUrl(channelSelector: string, _page: Page): Promise<Nullable<string>> {

  return findWatchUrl(channelSelector);
}

/**
 * Discovers all channels from the YouTube TV EPG grid. Returns cached results if the unified channel cache is populated from a prior tune or discovery call.
 * Otherwise, waits for the first grid row to confirm the guide has rendered (the route handler's networkidle2 navigation ensures all API data has arrived before
 * this function is called), then extracts all ~256 channels via discoverGuideChannels() and populates the cache (unless empty, to allow retries on transient
 * failures).
 * @param page - The Puppeteer page object.
 * @returns Array of discovered channels with affiliate tagging.
 */
async function discoverYttvChannels(page: Page): Promise<DiscoveredChannel[]> {

  // Return from the unified cache if a prior tune or discovery call already enumerated the lineup.
  const cached = yttvCache.cached();

  if(cached) {

    return cached;
  }

  // Wait for at least one EPG row to confirm the guide grid has rendered. The route handler navigates with networkidle2, which ensures all API data has arrived
  // before this function is called - no additional network idle wait is needed here.
  try {

    await page.waitForSelector("ytu-epg-row", { timeout: CONFIG.streaming.videoTimeout });
  } catch {

    return [];
  }

  const allChannels = await discoverGuideChannels(page);

  // Do not cache empty results - leave the cache empty so subsequent calls retry the full walk. Empty results can indicate no subscription or transient failures.
  if(allChannels.length === 0) {

    return [];
  }

  populateYttvChannelCache(allChannels);

  return yttvCache.discovered();
}

export const yttvProvider: ProviderModule = {

  discoverChannels: discoverYttvChannels,
  exportDurableLineup: exportYttvLineup,
  getCachedChannels: yttvCache.cached,
  guideUrl: "https://tv.youtube.com/live",
  label: "YouTube TV",

  // Profile for YouTube TV (tv.youtube.com/live). The guide grid is virtualized in #id-bottom-main-content, rendering visible rows with streamable watch URLs.
  // The youtubeGrid strategy traverses the virtualized guide via incremental scrolling with early exit on tune, populating the unified cache. Subsequent tunes
  // resolve directly via findWatchUrl(). Uses selectReadyVideo because the watch page has ~36 video elements (live preview thumbnails from the guide) but only
  // one active stream with readyState >= 3 and videoWidth > 0. Extends fullscreenApi: the watch page's player exposes the JavaScript fullscreen API on the active
  // video element.
  profile: {

    category: "multiChannel",
    channelSelection: { strategy: "youtubeGrid" },
    description: "YouTube TV with EPG grid channel selection. Set Channel Selector to the channel name as shown in the guide (e.g., CNN, ESPN, NBC).",
    extends: "fullscreenApi",
    selectReadyVideo: true,
    summary: "YouTube TV (guide grid, needs selector)"
  },
  profileName: "youtubeTV",
  slug: "yttv",
  strategy: {

    clearCache: clearYttvCache,
    execute: youtubeGridStrategy,

    // Only the failing selector's own key is dropped. The guide-name entries stay put, and the next strategy run reloads the guide and rebuilds them all with
    // fresh watch URLs.
    invalidateDirectUrl: yttvCache.invalidate,
    resolveDirectUrl: resolveYttvDirectUrl
  },
  strategyName: "youtubeGrid"
};
