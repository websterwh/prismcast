/* Copyright(C) 2024-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * drm.test.ts: Tests for the Prismcast Widevine CDM and segment decryption subsystem.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  DEFAULT_WVD_PATH,
  buildChallenge,
  decryptInitSegment,
  decryptMediaSegment,
  getDeviceInfo,
  resignChallenge
} from "./index.ts";

const execFileAsync = promisify(execFile);

// Sample KID & Key pair for test fixtures
const TEST_KID = "100102030405060708090a0b0c0d0e0f";
const TEST_KEY = "000102030405060708090a0b0c0d0e0f";

// Helper to check if the WVD file actually exists on this host
async function hasWvd(): Promise<boolean> {

  try {

    await fs.access(DEFAULT_WVD_PATH, fs.constants.R_OK);

    return true;
  } catch {

    return false;
  }
}

// Helper to craft a test encrypted fMP4 (init + segment) using shaka-packager
async function createEncryptedFixture(
  tmpDir: string
): Promise<{ encInit: Buffer; encSegment: Buffer }> {

  const packagerBin =
    "/home/william/Documents/projects/unshackle/unshackle/binaries/packager";
  const srcPath = path.join(tmpDir, "source.mp4");
  const initPath = path.join(tmpDir, "enc-init.mp4");
  const segPattern = path.join(tmpDir, "enc-$Number$.m4s");

  // 1) Generate small 2-second test video with ffmpeg
  await execFileAsync("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc=size=320x240:rate=30",
    "-t",
    "2",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    srcPath
  ]);

  // 2) Encrypt with shaka-packager
  await execFileAsync(packagerBin, [
    "--quiet",
    `in=${srcPath},stream=video,init_segment=${initPath},segment_template=${segPattern}`,
    "--enable_raw_key_encryption",
    `--keys=key_id=${TEST_KID}:key=${TEST_KEY}`,
    "--segment_duration=2"
  ]);

  const encInit = await fs.readFile(initPath);
  const encSegment = await fs.readFile(path.join(tmpDir, "enc-1.m4s"));

  return { encInit, encSegment };
}

test("Widevine CDM: Device Info", async (t) => {

  if(!(await hasWvd())) {

    t.skip("WVD file not present on this host");

    return;
  }

  await t.test("loads device and reports expected metadata", async () => {

    const info = await getDeviceInfo();

    assert.equal(info.security_level, 3, "Expected Security Level 3");
    assert.equal(info.type, "DeviceTypes.ANDROID", "Expected Android device type");
    assert.equal(info.has_client_id, true, "Expected client_id to be present");
    assert.equal(info.has_private_key, true, "Expected private_key to be present");
    assert.ok(info.system_id, "Expected valid system_id");
  });

  await t.test("throws meaningful error on nonexistent WVD path", async () => {

    await assert.rejects(
      async () => {

        await getDeviceInfo("/tmp/does_not_exist.wvd");
      },
      /No such file|Bridge execution failed/i
    );
  });
});

test("Widevine CDM: License Challenge Generation", async (t) => {

  if(!(await hasWvd())) {

    t.skip("WVD file not present on this host");

    return;
  }

  await t.test("generates challenge from a PSSH box", async () => {

    // Generate a minimal PSSH box using python pywidevine
    const pythonBin =
      "/home/william/Documents/projects/unshackle/.venv/bin/python";
    const { stdout } = await execFileAsync(pythonBin, [
      "-c",
      `
import base64
from uuid import UUID
from pywidevine.pssh import PSSH
p = PSSH.new(system_id=UUID("edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"), key_ids=["${TEST_KID}"])
print(base64.b64encode(p.dump()).decode('ascii'))
`
    ]);

    const psshB64 = stdout.trim();
    const result = await buildChallenge(psshB64);

    assert.ok(result.sessionId, "Expected a valid session ID");
    assert.ok(result.challenge.length > 500, "Challenge should be > 500 bytes");

    // Widevine challenges are protobuf SignedMessage starting with 0x08 (field 1 = type)
    assert.equal(result.challenge[0], 0x08, "Challenge should start with protobuf tag 0x08");
  });

  await t.test("resigns an existing challenge by extracting PSSH", async () => {

    const pythonBin =
      "/home/william/Documents/projects/unshackle/.venv/bin/python";
    const { stdout } = await execFileAsync(pythonBin, [
      "-c",
      `
import base64
from uuid import UUID
from pywidevine.pssh import PSSH
p = PSSH.new(system_id=UUID("edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"), key_ids=["${TEST_KID}"])
print(base64.b64encode(p.dump()).decode('ascii'))
`
    ]);

    const initialChallenge = await buildChallenge(stdout.trim());
    const resigned = await resignChallenge(initialChallenge.challenge);

    assert.ok(resigned.sessionId, "Expected a valid session ID from resigned challenge");
    assert.ok(resigned.challenge.length > 500, "Resigned challenge should be > 500 bytes");
    assert.equal(resigned.challenge[0], 0x08, "Resigned challenge should start with protobuf tag 0x08");
  });
});

test("fMP4 Segment Decryption", async (t) => {

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "prismcast-drm-test-"));

  try {

    const { encInit, encSegment } = await createEncryptedFixture(tmpDir);

    // Sanity check: encrypted fixture must contain encryption sample entry 'encv'
    assert.ok(
      encInit.includes(Buffer.from("encv")),
      "Fixture init must contain 'encv' sample entry"
    );

    await t.test("decryptInitSegment converts encv to avc1", async () => {

      const decInit = await decryptInitSegment(encInit, [
        { key: TEST_KEY, kid: TEST_KID }
      ]);

      assert.ok(decInit.length > 0, "Decrypted init must not be empty");
      assert.ok(
        decInit.includes(Buffer.from("avc1")),
        "Decrypted init must contain 'avc1' sample entry"
      );
      assert.ok(
        !decInit.includes(Buffer.from("encv")),
        "Decrypted init must NOT contain 'encv' sample entry"
      );
    });

    await t.test("decryptMediaSegment produces a playable decrypted stream", async () => {

      const decInit = await decryptInitSegment(encInit, [
        { key: TEST_KEY, kid: TEST_KID }
      ]);
      const decSegment = await decryptMediaSegment(encInit, encSegment, [
        { key: TEST_KEY, kid: TEST_KID }
      ]);

      assert.ok(decSegment.length > 0, "Decrypted segment must not be empty");

      // Verify that decInit + decSegment together can be probed cleanly by ffprobe
      const assembledPath = path.join(tmpDir, "dec-assembled.mp4");

      await fs.writeFile(assembledPath, Buffer.concat([ decInit, decSegment ]));

      const { stdout } = await execFileAsync("ffprobe", [
        "-v",
        "error",
        "-show_entries",
        "stream=codec_name,width,height",
        "-of",
        "csv=p=0",
        assembledPath
      ]);

      const [ codec, width, height ] = stdout.trim().split(",");

      assert.equal(codec, "h264");
      assert.equal(width, "320");
      assert.equal(height, "240");
    });

    await t.test("fails when no keys are provided", async () => {

      await assert.rejects(
        async () => {

          await decryptInitSegment(encInit, []);
        },
        /Cannot decrypt without at least one DRM key/
      );
    });
  } finally {

    try {

      await fs.rm(tmpDir, { force: true, recursive: true });
    } catch {

      // Ignored.
    }
  }
});
