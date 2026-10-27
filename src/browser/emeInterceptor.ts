/* Copyright(C) 2024-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * emeInterceptor.ts: In-browser Encrypted Media Extensions (EME) hook for Widevine key extraction.
 */

import type { DrmContext, DrmKey } from "../drm/types.ts";
import { parseLicense, resignChallenge } from "../drm/widevine.ts";
import type { Clock } from "homebridge-plugin-utils";
import { LOG } from "../utils/index.ts";
import type { Page } from "puppeteer-core";
import { systemClock } from "homebridge-plugin-utils";

/**
 * Handle returned by installEmeInterceptor.
 */
export interface EmeInterceptorHandle extends Disposable {

  /** Map of acquired keys keyed by hex KID. */
  readonly acquiredKeys: Map<string, DrmKey>;
  /** Waits for at least one key to be acquired, or rejects on timeout. */
  waitForKeys: (timeoutMs?: number) => Promise<DrmKey[]>;
}

/**
 * Injected script string evaluated before any page script runs.
 * Intercepts MediaKeySession message (challenge) and update (license) events.
 */
const EME_HOOK_SCRIPT = [
  "(() => {",
  "  if (typeof window === \"undefined\" || window.__prismcast_eme_installed) return;",
  "  window.__prismcast_eme_installed = true;",
  "  const sessionMap = new WeakMap();",
  "  if (typeof MediaKeySession !== \"undefined\") {",
  "    const originalAddEventListener = MediaKeySession.prototype.addEventListener;",
  "    MediaKeySession.prototype.addEventListener = function(type, listener, options) {",
  "      if (type !== \"message\") {",
  "        return originalAddEventListener.call(this, type, listener, options);",
  "      }",
  "      const wrappedListener = async (event) => {",
  "        if (!event || !event.message || event.message.byteLength <= 2) {",
  "          return typeof listener === \"function\" ? listener.call(this, event) : listener.handleEvent(event);",
  "        }",
  "        try {",
  "          const rawBytes = new Uint8Array(event.message);",
  "          let b64 = \"\";",
  "          for (let i = 0; i < rawBytes.length; i++) {",
  "            b64 += String.fromCharCode(rawBytes[i]);",
  "          }",
  "          const challengeB64 = btoa(b64);",
  "          if (window.__prismcast_resign_challenge) {",
  "            const resignRes = await window.__prismcast_resign_challenge(challengeB64);",
  "            if (resignRes && resignRes.challengeB64) {",
  "              const binStr = atob(resignRes.challengeB64);",
  "              const newBuf = new Uint8Array(binStr.length);",
  "              for (let i = 0; i < binStr.length; i++) {",
  "                newBuf[i] = binStr.charCodeAt(i);",
  "              }",
  "              sessionMap.set(this, resignRes.sessionId);",
  "              Object.defineProperty(event, \"message\", {",
  "                configurable: true,",
  "                get: () => newBuf.buffer",
  "              });",
  "            }",
  "          }",
  "        } catch (err) {",
  "          console.warn(\"[Prismcast EME] Challenge resign error:\", err);",
  "        }",
  "        return typeof listener === \"function\" ? listener.call(this, event) : listener.handleEvent(event);",
  "      };",
  "      return originalAddEventListener.call(this, type, wrappedListener, options);",
  "    };",
  "    const originalUpdate = MediaKeySession.prototype.update;",
  "    MediaKeySession.prototype.update = async function(response) {",
  "      try {",
  "        const sessionId = sessionMap.get(this);",
  "        if (sessionId && response && window.__prismcast_on_license) {",
  "          const rawBytes = new Uint8Array(response);",
  "          let b64 = \"\";",
  "          for (let i = 0; i < rawBytes.length; i++) {",
  "            b64 += String.fromCharCode(rawBytes[i]);",
  "          }",
  "          window.__prismcast_on_license(sessionId, btoa(b64));",
  "        }",
  "      } catch (err) {",
  "        console.warn(\"[Prismcast EME] License capture error:\", err);",
  "      }",
  "      try {",
  "        return await originalUpdate.call(this, response);",
  "      } catch (e) {",
  "        // Ignored: expected to fail on browser CDM since license was encrypted for our WVD",
  "      }",
  "    };",
  "  }",
  "})();"
].join("\n");

/**
 * Installs an EME hook on the given page to intercept Widevine license challenges and responses.
 *
 * @param page - The Puppeteer page object.
 * @param onKeys - Optional callback invoked whenever keys are acquired.
 * @param ctx - Optional DRM context.
 * @param clock - Optional Clock instance. Defaults to systemClock.
 * @returns Handle providing access to acquired keys and disposal.
 */
export async function installEmeInterceptor(
  page: Page,
  onKeys?: (keys: DrmKey[]) => void,
  ctx?: DrmContext,
  clock: Clock = systemClock
): Promise<EmeInterceptorHandle> {

  const acquiredKeys = new Map<string, DrmKey>();
  let keyWaiters: { resolve: (keys: DrmKey[]) => void; reject: (err: Error) => void }[] = [];

  function notifyKeys(newKeys: DrmKey[]): void {

    for(const k of newKeys) {

      acquiredKeys.set(k.kid.toLowerCase(), k);
    }

    if(newKeys.length > 0) {

      onKeys?.(newKeys);
      const current = Array.from(acquiredKeys.values());
      const waiters = keyWaiters;

      keyWaiters = [];

      for(const w of waiters) {

        w.resolve(current);
      }
    }
  }

  // Expose bridge hooks to page context
  try {

    await page.exposeFunction("__prismcast_resign_challenge", async (challengeB64: string) => {

      try {

        const result = await resignChallenge(challengeB64, undefined, ctx);

        return {

          challengeB64: result.challenge.toString("base64"),
          sessionId: result.sessionId
        };
      } catch(error) {

        LOG.warn("Failed to resign Widevine challenge: %s", String(error));

        return null;
      }
    });
  } catch {

    // Already exposed on page or session detached.
  }

  try {

    await page.exposeFunction("__prismcast_on_license", async (sessionId: string, licenseB64: string) => {

      try {

        const keys = await parseLicense(sessionId, licenseB64, undefined, ctx);

        LOG.info("Acquired %d Widevine content keys.", keys.length);
        notifyKeys(keys);
      } catch(error) {

        LOG.warn("Failed to parse Widevine license response: %s", String(error));
      }
    });
  } catch {

    // Already exposed on page or session detached.
  }
  // Inject the EME hook script before any document loads
  await page.evaluateOnNewDocument(EME_HOOK_SCRIPT);

  return {

    acquiredKeys,
    [Symbol.dispose](): void {

      keyWaiters = [];
    },
    waitForKeys(timeoutMs = 15000): Promise<DrmKey[]> {

      if(acquiredKeys.size > 0) {

        return Promise.resolve(Array.from(acquiredKeys.values()));
      }

      return new Promise<DrmKey[]>((resolve, reject) => {

        const timer = clock.schedule(() => {

          reject(new Error("Timed out waiting for DRM keys"));
        }, timeoutMs);

        keyWaiters.push({

          reject: (err) => {

            timer[Symbol.dispose]();
            reject(err);
          },
          resolve: (keys) => {

            timer[Symbol.dispose]();
            resolve(keys);
          }
        });
      });
    }
  };
}
