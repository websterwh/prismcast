/* Copyright(C) 2024-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * widevine.ts: Widevine CDM client using the Python sidecar bridge.
 */

/* eslint-disable camelcase */
import type { DrmContext, DrmKey, WidevineChallenge, WidevineDeviceInfo } from "./types.ts";
import { existsSync, readdirSync } from "node:fs";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";
import path from "node:path";
const currentDir = path.dirname(fileURLToPath(import.meta.url));

/** Well-known fallback candidate paths for the python interpreter with pywidevine. */
const DEFAULT_PYTHON_CANDIDATES = [
  process.env["PRISMCAST_PYTHON_BIN"],
  "/opt/prismcast-drm-venv/bin/python",
  "/opt/prismcast-drm-venv/bin/python3",
  "/home/william/Documents/projects/unshackle/.venv/bin/python",
  "/home/william/Documents/projects/unshackle/.venv/bin/python3",
  "python3"
].filter((p): p is string => Boolean(p));

/** Default Widevine Device file location on this host. */
export const DEFAULT_WVD_PATH =
  "/home/william/Documents/projects/unshackle/unshackle/WVDs/google_aosp_on_ia_emulator_14.0.0_f63e4253_4464_l3.wvd";

/** Candidate paths for Widevine Device (.wvd) files across bare metal and container environments. */
const DEFAULT_WVD_CANDIDATES = [
  process.env["PRISMCAST_WVD_PATH"],
  "/root/.prismcast/drm/device.wvd",
  "/root/.prismcast/device.wvd",
  "/etc/prismcast/drm/device.wvd",
  DEFAULT_WVD_PATH
].filter((p): p is string => Boolean(p));

/** Candidate directories to search for any *.wvd device file. */
const DEFAULT_WVD_DIRECTORIES = [
  "/root/.prismcast/drm",
  "/root/.prismcast",
  "/etc/prismcast/drm",
  "/home/william/Documents/projects/unshackle/unshackle/WVDs"
];

/** Default bridge script path relative to this file. */
export const DEFAULT_BRIDGE_PATH = path.join(currentDir, "widevine_bridge.py");

/**
 * Resolves the path to the widevine_bridge.py script across source, dist, and global npm installs.
 */
export function resolveBridgePath(ctx?: DrmContext): string {

  if(ctx?.widevineBridgePath) {

    return ctx.widevineBridgePath;
  }

  const candidates = [
    path.join(currentDir, "widevine_bridge.py"),
    path.resolve(currentDir, "../../src/drm/widevine_bridge.py"),
    path.resolve(currentDir, "../src/drm/widevine_bridge.py"),
    "/usr/lib/node_modules/prismcast/dist/drm/widevine_bridge.py",
    "/usr/local/lib/node_modules/prismcast/dist/drm/widevine_bridge.py",
    "/usr/lib/node_modules/prismcast/src/drm/widevine_bridge.py",
    "/app/src/drm/widevine_bridge.py",
    DEFAULT_BRIDGE_PATH
  ];

  for(const candidate of candidates) {

    if(existsSync(candidate)) {

      return candidate;
    }
  }

  return DEFAULT_BRIDGE_PATH;
}

/**
 * Resolves the Python executable path.
 */
export async function resolvePythonBin(ctx?: DrmContext): Promise<string> {

  if(ctx?.pythonBin) {

    return ctx.pythonBin;
  }

  for(const candidate of DEFAULT_PYTHON_CANDIDATES) {

    if(existsSync(candidate)) {

      return candidate;
    }
  }

  return "python3";
}

/**
 * Resolves the WVD device path.
 */
export function resolveWvdPath(wvdPath?: string, ctx?: DrmContext): string {

  if(wvdPath) {

    return wvdPath;
  }

  if(ctx?.wvdPath) {

    return ctx.wvdPath;
  }

  for(const candidate of DEFAULT_WVD_CANDIDATES) {

    if(existsSync(candidate)) {

      return candidate;
    }
  }

  for(const dir of DEFAULT_WVD_DIRECTORIES) {

    if(existsSync(dir)) {

      try {

        const files = readdirSync(dir);
        const match = files.find((f) => f.toLowerCase().endsWith(".wvd"));

        if(match) {

          return path.join(dir, match);
        }
      } catch {

        // Ignore directory read errors and continue searching
      }
    }
  }

  return DEFAULT_WVD_PATH;
}

/**
 * Checks whether Widevine DRM decryption is available on this host.
 * Returns true if the .wvd device file exists and is readable.
 */
export async function isDrmAvailable(ctx?: DrmContext): Promise<boolean> {

  try {

    const wvd = resolveWvdPath(undefined, ctx);

    await fs.access(wvd, fs.constants.R_OK);

    return true;
  } catch {

    return false;
  }
}

interface BridgeResponse<T = unknown> {

  error?: string;
  result?: T;
  status: "error" | "ok";
}

/**
 * Executes a single command on the Widevine bridge script over stdin/stdout.
 */
async function callBridge<T>(
  request: Record<string, unknown>,
  ctx?: DrmContext
): Promise<T> {

  const pythonBin = await resolvePythonBin(ctx);
  const bridgeScript = resolveBridgePath(ctx);

  return new Promise<T>((resolve, reject) => {

    const proc = execFile(
      pythonBin,
      [ bridgeScript, "--json" ],
      { maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {

        if(error) {

          reject(new Error("Bridge execution failed: " + error.message + (stderr ? " (" + stderr.trim() + ")" : "")));

          return;
        }

        try {

          const resp = JSON.parse(stdout.trim()) as BridgeResponse<T>;

          if(resp.status !== "ok") {

            reject(new Error(resp.error ?? "Unknown bridge failure"));

            return;
          }
          resolve(resp.result as T);
        } catch(parseError) {

          reject(new Error("Failed to parse bridge output: " + String(parseError) + " | raw: " + stdout));
        }
      }
    );

    proc.stdin?.write(JSON.stringify(request) + "\n");
    proc.stdin?.end();
  });
}

/**
 * Queries device information and security level from a Widevine device file.
 *
 * @param wvdPath - Path to the .wvd file. Defaults to DEFAULT_WVD_PATH.
 * @param ctx - Optional runtime context.
 */
export async function getDeviceInfo(
  wvdPath?: string,
  ctx?: DrmContext
): Promise<WidevineDeviceInfo> {

  const resolvedWvd = resolveWvdPath(wvdPath, ctx);

  return callBridge<WidevineDeviceInfo>(
    { cmd: "device_info", wvd_path: resolvedWvd },
    ctx
  );
}

/**
 * Builds a Widevine license challenge for a given PSSH box.
 *
 * @param pssh - The PSSH box as a Buffer or base64 string.
 * @param wvdPath - Optional path to the .wvd device.
 * @param ctx - Optional runtime context.
 * @returns Challenge result containing the raw challenge buffer and correlating session ID.
 */
export async function buildChallenge(
  pssh: Buffer | string,
  wvdPath?: string,
  ctx?: DrmContext
): Promise<WidevineChallenge> {

  const resolvedWvd = resolveWvdPath(wvdPath, ctx);
  const psshB64 = Buffer.isBuffer(pssh) ? pssh.toString("base64") : pssh;

  interface RawChallengeResult {

    challenge_b64: string;
    challenge_bytes: number;
    session_id: string;
  }

  const raw = await callBridge<RawChallengeResult>(
    { cmd: "build_challenge", pssh_b64: psshB64, wvd_path: resolvedWvd },
    ctx
  );

  return {

    challenge: Buffer.from(raw.challenge_b64, "base64"),
    sessionId: raw.session_id
  };
}

/**
 * Resigns an intercepted browser Widevine challenge using our local WVD device,
 * enabling seamless key extraction from the upstream DRM server response.
 *
 * @param challenge - The browser's intercepted challenge as a Buffer or base64 string.
 * @param wvdPath - Optional path to the .wvd device.
 * @param ctx - Optional runtime context.
 * @returns Challenge result containing the new challenge buffer and correlating session ID.
 */
export async function resignChallenge(
  challenge: Buffer | string,
  wvdPath?: string,
  ctx?: DrmContext
): Promise<WidevineChallenge> {

  const resolvedWvd = resolveWvdPath(wvdPath, ctx);
  const challengeB64 = Buffer.isBuffer(challenge) ? challenge.toString("base64") : challenge;

  interface RawResignResult {

    challenge_b64: string;
    challenge_bytes: number;
    session_id: string;
  }

  const raw = await callBridge<RawResignResult>(
    { challenge_b64: challengeB64, cmd: "resign_challenge", wvd_path: resolvedWvd },
    ctx
  );

  return {

    challenge: Buffer.from(raw.challenge_b64, "base64"),
    sessionId: raw.session_id
  };
}

/**
 * Parses a Widevine license server response, returning the extracted Content Decryption Keys.
 *
 * @param sessionId - The session ID returned from buildChallenge().
 * @param licenseResponse - Raw license response bytes returned by the DRM server.
 * @param wvdPath - Optional path to the .wvd device.
 * @param ctx - Optional runtime context.
 * @returns Array of decrypted DRM keys (KID:KEY pairs).
 */
export async function parseLicense(
  sessionId: string,
  licenseResponse: Buffer | string,
  wvdPath?: string,
  ctx?: DrmContext
): Promise<DrmKey[]> {

  const resolvedWvd = resolveWvdPath(wvdPath, ctx);
  const licenseB64 = Buffer.isBuffer(licenseResponse) ?
    licenseResponse.toString("base64") :
    licenseResponse;

  interface RawParseResult {

    keys: DrmKey[];
  }

  const res = await callBridge<RawParseResult>(
    {

      cmd: "parse_license",
      license_b64: licenseB64,
      session_id: sessionId,
      wvd_path: resolvedWvd
    },
    ctx
  );

  return res.keys;
}
