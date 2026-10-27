/* Copyright(C) 2024-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * decrypt.ts: fMP4 segment decryption using Bento4 mp4decrypt.
 */

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { DrmContext, DrmKey } from "./types.ts";

const execFileAsync = promisify(execFile);

/** Well-known fallback candidate paths for the mp4decrypt binary. */
const DEFAULT_MP4DECRYPT_CANDIDATES = [
  "/home/william/Documents/projects/unshackle/unshackle/binaries/mp4decrypt",
  "/usr/local/bin/mp4decrypt",
  "/usr/bin/mp4decrypt"
];

/**
 * Resolves the path to the mp4decrypt executable.
 */
export async function resolveMp4DecryptBin(ctx?: DrmContext): Promise<string> {

  if(ctx?.mp4decryptBin) {

    return ctx.mp4decryptBin;
  }

  for(const candidate of DEFAULT_MP4DECRYPT_CANDIDATES) {

    try {

      await fs.access(candidate, fs.constants.X_OK);

      return candidate;
    } catch {

      // Continue searching
    }
  }

  // Fallback to PATH lookup
  return "mp4decrypt";
}

/**
 * Builds the `--key <kid>:<key>` arguments for mp4decrypt.
 */
function buildKeyArgs(keys: readonly DrmKey[]): string[] {

  if(keys.length === 0) {

    throw new Error("Cannot decrypt without at least one DRM key.");
  }
  const args: string[] = [];

  for(const k of keys) {

    // Normalise to clean hex without dashes or colons
    const cleanKid = k.kid.replaceAll("-", "").toLowerCase();
    const cleanKey = k.key.replaceAll("-", "").toLowerCase();

    args.push("--key", `${cleanKid}:${cleanKey}`);
  }

  return args;
}

/**
 * Decrypts an fMP4 initialization segment, converting protected sample entries
 * (`encv`, `enca`) back to standard unencrypted entries (`avc1`, `mp4a`).
 *
 * @param encInit - Raw encrypted initialization segment bytes.
 * @param keys - Content keys applicable to this stream.
 * @param ctx - Optional runtime context resolving the mp4decrypt binary.
 * @returns Plaintext decrypted initialization segment bytes.
 */
export async function decryptInitSegment(
  encInit: Buffer,
  keys: readonly DrmKey[],
  ctx?: DrmContext
): Promise<Buffer> {

  const bin = await resolveMp4DecryptBin(ctx);
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "prismcast-drm-init-"));

  const inPath = path.join(tmpDir, "enc-init.mp4");
  const outPath = path.join(tmpDir, "dec-init.mp4");

  try {

    await fs.writeFile(inPath, encInit);

    const args = [ ...buildKeyArgs(keys), inPath, outPath ];

    await execFileAsync(bin, args);

    return await fs.readFile(outPath);
  } finally {

    try {

      await fs.rm(tmpDir, { force: true, recursive: true });
    } catch {

      // Ignored.
    }
  }
}

/**
 * Decrypts an individual fMP4 media segment (.m4s) given the corresponding
 * initialization segment for track layout information.
 *
 * @param encInit - Raw encrypted initialization segment bytes (provides track info).
 * @param encSegment - Raw encrypted media segment bytes (.m4s).
 * @param keys - Content keys applicable to this stream.
 * @param ctx - Optional runtime context resolving the mp4decrypt binary.
 * @returns Plaintext decrypted media segment bytes (.m4s).
 */
export async function decryptMediaSegment(
  encInit: Buffer,
  encSegment: Buffer,
  keys: readonly DrmKey[],
  ctx?: DrmContext
): Promise<Buffer> {

  const bin = await resolveMp4DecryptBin(ctx);
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "prismcast-drm-seg-"));

  const initPath = path.join(tmpDir, "enc-init.mp4");
  const inPath = path.join(tmpDir, "enc-seg.m4s");
  const outPath = path.join(tmpDir, "dec-seg.m4s");

  try {

    await fs.writeFile(initPath, encInit);
    await fs.writeFile(inPath, encSegment);

    const args = [
      ...buildKeyArgs(keys),
      "--fragments-info",
      initPath,
      inPath,
      outPath
    ];

    await execFileAsync(bin, args);

    return await fs.readFile(outPath);
  } finally {

    try {

      await fs.rm(tmpDir, { force: true, recursive: true });
    } catch {

      // Ignored.
    }
  }
}
