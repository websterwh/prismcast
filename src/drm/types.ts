/* Copyright(C) 2024-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * types.ts: Type definitions for the Prismcast DRM subsystem.
 */

/**
 * A Content Decryption Key pair (KID + Key) in lowercase hexadecimal notation.
 */
export interface DrmKey {

  /** 128-bit Key ID as a 32-character hex string (e.g. "100102030405060708090a0b0c0d0e0f"). */
  kid: string;
  /** 128-bit AES key as a 32-character hex string. */
  key: string;
  /** Optional key type from the license (e.g. "CONTENT", "SIGNING"). */
  type?: string;
}

/**
 * Metadata reported by a loaded Widevine Device (.wvd) file.
 */
export interface WidevineDeviceInfo {

  has_client_id: boolean;
  has_private_key: boolean;
  security_level: number;
  system_id: number | string;
  type: string;
}

/**
 * Result of creating a Widevine license challenge from a PSSH box.
 */
export interface WidevineChallenge {

  /** Raw challenge bytes to POST to the license server. */
  challenge: Buffer;
  /** Internal CDM session identifier (hex) needed to correlate the license response. */
  sessionId: string;
}

/**
 * Runtime execution context resolving python, the bridge script, and decryption binaries.
 */
export interface DrmContext {

  /** Path to the Bento4 mp4decrypt binary. */
  mp4decryptBin?: string;
  /** Path to the Python interpreter with pywidevine installed. */
  pythonBin?: string;
  /** Path to the Widevine bridge script (src/drm/widevine_bridge.py). */
  widevineBridgePath?: string;
  /** Default .wvd path to use if omitted at call sites. */
  wvdPath?: string;
}
