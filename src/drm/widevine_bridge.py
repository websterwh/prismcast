#!/usr/bin/env python3
"""
Widevine CDM bridge for Prismcast.
Exposes pywidevine CDM operations (device loading, challenge generation, license parsing)
via single-shot CLI commands or line-delimited JSON RPC on stdin.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import pickle
import sys
from typing import Any, Dict, List
from uuid import UUID

from pywidevine.cdm import Cdm
from pywidevine.device import Device
from pywidevine.license_protocol_pb2 import LicenseRequest, SignedMessage, WidevinePsshData
from pywidevine.pssh import PSSH

# In-memory CDM cache keyed by normalized wvd_path so repeated calls within
# the same process don't re-read and re-parse the device protobuf.
_DEVICE_CACHE: Dict[str, Device] = {}
_CDM_SESSIONS: Dict[str, tuple[Cdm, bytes]] = {}  # session_id_hex -> (cdm, raw_session_id)


def _save_session(session_id: bytes, session_obj: Any) -> None:
    try:
        sess_file = f"/tmp/prismcast_cdm_{session_id.hex()}.pkl"
        with open(sess_file, "wb") as f:
            pickle.dump(session_obj, f)
    except Exception as e:
        sys.stderr.write(f"Failed to persist CDM session: {e}\n")


def _restore_session(cdm: Cdm, session_id: bytes) -> bool:
    sess_file = f"/tmp/prismcast_cdm_{session_id.hex()}.pkl"
    if not os.path.exists(sess_file):
        return False
    try:
        with open(sess_file, "rb") as f:
            session_obj = pickle.load(f)
        sessions_dict = getattr(cdm, "_Cdm__sessions", None)
        if sessions_dict is not None:
            sessions_dict[session_id] = session_obj
        try:
            os.remove(sess_file)
        except OSError:
            pass
        return True
    except Exception as e:
        sys.stderr.write(f"Failed to restore CDM session: {e}\n")
        return False


def _get_cdm(wvd_path: str) -> Cdm:
    if wvd_path not in _DEVICE_CACHE:
        _DEVICE_CACHE[wvd_path] = Device.load(wvd_path)
    return Cdm.from_device(_DEVICE_CACHE[wvd_path])


def cmd_device_info(wvd_path: str) -> Dict[str, Any]:
    dev = Device.load(wvd_path)
    return {
        "type": str(dev.type),
        "security_level": dev.security_level,
        "system_id": dev.system_id.hex() if hasattr(dev.system_id, "hex") else dev.system_id,
        "has_client_id": dev.client_id is not None,
        "has_private_key": dev.private_key is not None,
    }


def cmd_build_challenge(wvd_path: str, pssh_b64: str) -> Dict[str, Any]:
    cdm = _get_cdm(wvd_path)
    pssh_bytes = base64.b64decode(pssh_b64)
    pssh = PSSH(pssh_bytes)

    session_id = cdm.open()
    session_id_hex = session_id.hex()
    challenge = cdm.get_license_challenge(session_id, pssh)
    session_obj = getattr(cdm, "_Cdm__sessions")[session_id]
    _CDM_SESSIONS[session_id_hex] = (cdm, session_id)
    _save_session(session_id, session_obj)
    return {
        "session_id": session_id_hex,
        "challenge_b64": base64.b64encode(challenge).decode("ascii"),
        "challenge_bytes": len(challenge),
    }


def cmd_resign_challenge(wvd_path: str, challenge_b64: str) -> Dict[str, Any]:
    cdm = _get_cdm(wvd_path)
    challenge_bytes = base64.b64decode(challenge_b64)

    sm = SignedMessage()
    sm.ParseFromString(challenge_bytes)

    req = LicenseRequest()
    req.ParseFromString(sm.msg)

    if not req.content_id.widevine_pssh_data.pssh_data:
        raise ValueError("No pssh_data found in challenge LicenseRequest")

    wp = WidevinePsshData()
    wp.ParseFromString(req.content_id.widevine_pssh_data.pssh_data[0])

    pssh = PSSH.new(system_id=UUID("edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"), init_data=wp)

    session_id = cdm.open()
    session_id_hex = session_id.hex()
    new_challenge = cdm.get_license_challenge(session_id, pssh)
    session_obj = getattr(cdm, "_Cdm__sessions")[session_id]
    _CDM_SESSIONS[session_id_hex] = (cdm, session_id)
    _save_session(session_id, session_obj)
    return {
        "session_id": session_id_hex,
        "challenge_b64": base64.b64encode(new_challenge).decode("ascii"),
        "challenge_bytes": len(new_challenge),
    }


def cmd_parse_license(wvd_path: str, session_id_hex: str, license_b64: str) -> Dict[str, Any]:
    session_id = bytes.fromhex(session_id_hex)
    if session_id_hex in _CDM_SESSIONS:
        cdm, session_id = _CDM_SESSIONS[session_id_hex]
    else:
        cdm = _get_cdm(wvd_path)
        if not _restore_session(cdm, session_id):
            raise KeyError(f"Session {session_id_hex} not found and could not be restored from storage.")

    license_bytes = base64.b64decode(license_b64)

    cdm.parse_license(session_id, license_bytes)

    keys: List[Dict[str, str]] = []
    for key in cdm.get_keys(session_id):
        kid_val = getattr(key, "kid", None)
        if isinstance(kid_val, UUID):
            kid_str = kid_val.hex
        elif hasattr(kid_val, "hex") and callable(kid_val.hex):
            kid_str = kid_val.hex()
        else:
            kid_str = str(kid_val).replace("-", "")

        key_val = getattr(key, "key", None)
        if hasattr(key_val, "hex") and callable(key_val.hex):
            key_str = key_val.hex()
        else:
            key_str = str(key_val).replace("-", "")

        key_type = getattr(key, "type", getattr(key, "type_", "CONTENT"))

        keys.append({
            "kid": kid_str.lower(),
            "key": key_str.lower(),
            "type": str(key_type),
        })
    # Close session once parsed
    try:
        cdm.close(session_id)
    finally:
        _CDM_SESSIONS.pop(session_id_hex, None)

    return {"keys": keys}


def handle_request(req: Dict[str, Any]) -> Dict[str, Any]:
    cmd = req.get("cmd")
    try:
        if cmd == "ping":
            return {"status": "ok"}
        if cmd == "device_info":
            return {"status": "ok", "result": cmd_device_info(req["wvd_path"])}
        if cmd == "build_challenge":
            return {"status": "ok", "result": cmd_build_challenge(req["wvd_path"], req["pssh_b64"])}
        if cmd == "resign_challenge":
            return {"status": "ok", "result": cmd_resign_challenge(req["wvd_path"], req["challenge_b64"])}
        if cmd == "parse_license":
            return {"status": "ok", "result": cmd_parse_license(req["wvd_path"], req["session_id"], req["license_b64"])}
        return {"status": "error", "error": f"Unknown command: {cmd}"}
    except Exception as e:
        import traceback
        traceback.print_exc(file=sys.stderr)
        return {"status": "error", "error": f"{type(e).__name__}: {e}"}

def main() -> int:
    parser = argparse.ArgumentParser(description="Prismcast Widevine CDM Bridge")
    parser.add_argument("--device-info", metavar="WVD_PATH", help="Print device info as JSON and exit")
    parser.add_argument("--json", action="store_true", help="Process JSON request from stdin and output JSON to stdout")
    args = parser.parse_args()

    if args.device_info:
        try:
            print(json.dumps(cmd_device_info(args.device_info), indent=2))
            return 0
        except Exception as e:
            sys.stderr.write(f"Error: {e}\n")
            return 1

    if args.json:
        line = sys.stdin.readline()
        if not line:
            return 0
        req = json.loads(line)
        resp = handle_request(req)
        print(json.dumps(resp))
        if resp.get("status") != "ok":
            sys.stderr.write(f"Bridge error: {resp.get('error')}\n")
        return 0 if resp.get("status") == "ok" else 1
    # Default to line-delimited interactive loop over stdin
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            resp = handle_request(req)
            print(json.dumps(resp), flush=True)
        except Exception as e:
            print(json.dumps({"status": "error", "error": f"Malformed input: {e}"}), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
