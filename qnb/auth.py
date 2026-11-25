"""Authentication helpers: TOTP MFA, recovery codes, SVG QR rendering, and WebAuthn passkeys."""

import base64
import hashlib
import hmac
import io
import json
import re
import secrets
import struct
import time
from urllib.parse import quote

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec, padding, rsa

RECOVERY_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"


def b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def b64url_decode(text: str) -> bytes:
    if not isinstance(text, str) or not text:
        raise ValueError("Invalid base64url string")
    padded = text + "=" * ((4 - len(text) % 4) % 4)
    return base64.urlsafe_b64decode(padded.encode("ascii"))


def generate_totp_secret() -> str:
    return base64.b32encode(secrets.token_bytes(20)).decode("ascii").rstrip("=")


def totp_uri(email: str, secret: str, issuer: str = "QNB") -> str:
    label = quote(f"{issuer}:{email}")
    return f"otpauth://totp/{label}?secret={secret}&issuer={quote(issuer)}&algorithm=SHA1&digits=6&period=30"


def _totp_at(key: bytes, counter: int) -> str:
    digest = hmac.new(key, struct.pack(">Q", counter), hashlib.sha1).digest()
    offset = digest[-1] & 0x0F
    code = struct.unpack(">I", digest[offset:offset + 4])[0] & 0x7FFFFFFF
    return f"{code % 1000000:06d}"


def verify_totp(secret: str, code: str, now: float | None = None, window: int = 1) -> bool:
    if not isinstance(secret, str) or not isinstance(code, str):
        return False
    cleaned = re.sub(r"[\s-]+", "", code)
    if not re.fullmatch(r"\d{6}", cleaned):
        return False
    try:
        padded = secret + "=" * ((8 - len(secret) % 8) % 8)
        key = base64.b32decode(padded.encode("ascii"), casefold=True)
    except (ValueError, UnicodeEncodeError):
        return False
    step = int((time.time() if now is None else now) // 30)
    matched = False
    for delta in range(-window, window + 1):
        if hmac.compare_digest(_totp_at(key, step + delta), cleaned):
            matched = True
    return matched


def normalize_recovery_code(code: str) -> str:
    return re.sub(r"[^A-Za-z0-9]", "", code).upper()


def hash_recovery_code(code: str) -> str:
    return hashlib.sha256(normalize_recovery_code(code).encode("utf-8")).hexdigest()


def generate_recovery_codes(count: int = 8) -> tuple[list[str], list[str]]:
    codes = []
    hashes_list = []
    for _ in range(count):
        raw = "".join(secrets.choice(RECOVERY_ALPHABET) for _ in range(8))
        formatted = f"{raw[:4]}-{raw[4:]}"
        codes.append(formatted)
        hashes_list.append(hash_recovery_code(formatted))
    return codes, hashes_list


def qr_svg_data_url(text: str) -> str:
    try:
        import qrcode
        from qrcode.image.svg import SvgPathImage
    except ImportError:
        return ""
    qr = qrcode.QRCode(
        version=None,
        error_correction=qrcode.constants.ERROR_CORRECT_M,
        box_size=8,
        border=2,
    )
    qr.add_data(text)
    qr.make(fit=True)
    img = qr.make_image(image_factory=SvgPathImage)
    buf = io.BytesIO()
    img.save(buf)
    return "data:image/svg+xml;base64," + base64.b64encode(buf.getvalue()).decode("ascii")


def cbor_decode(data: bytes, offset: int = 0, depth: int = 0):
    if depth > 16 or offset >= len(data):
        raise ValueError("Invalid CBOR data")
    initial = data[offset]
    offset += 1
    major = initial >> 5
    additional = initial & 0x1F

    def read_uint(info: int) -> tuple[int, int]:
        nonlocal offset
        if info < 24:
            return info, offset
        sizes = {24: 1, 25: 2, 26: 4, 27: 8}
        if info not in sizes:
            raise ValueError("Unsupported CBOR integer encoding")
        size = sizes[info]
        if offset + size > len(data):
            raise ValueError("Truncated CBOR integer")
        val = int.from_bytes(data[offset:offset + size], "big")
        offset += size
        return val, offset

    if major == 0:
        val, offset = read_uint(additional)
        return val, offset
    if major == 1:
        val, offset = read_uint(additional)
        return -1 - val, offset
    if major == 2:
        length, offset = read_uint(additional)
        if offset + length > len(data):
            raise ValueError("Truncated CBOR bytes")
        return data[offset:offset + length], offset + length
    if major == 3:
        length, offset = read_uint(additional)
        if offset + length > len(data):
            raise ValueError("Truncated CBOR text")
        return data[offset:offset + length].decode("utf-8"), offset + length
    if major == 4:
        length, offset = read_uint(additional)
        items = []
        for _ in range(length):
            item, offset = cbor_decode(data, offset, depth + 1)
            items.append(item)
        return items, offset
    if major == 5:
        length, offset = read_uint(additional)
        mapping = {}
        for _ in range(length):
            key, offset = cbor_decode(data, offset, depth + 1)
            val, offset = cbor_decode(data, offset, depth + 1)
            mapping[key] = val
        return mapping, offset
    if major == 7:
        if additional == 20:
            return False, offset
        if additional == 21:
            return True, offset
        if additional in (22, 23):
            return None, offset
    raise ValueError(f"Unsupported CBOR type {major}:{additional}")


def _verify_client_data(client_data_b64: str, expected_type: str, expected_challenge: str, expected_origins: set[str]) -> bytes:
    raw = b64url_decode(client_data_b64)
    data = json.loads(raw.decode("utf-8"))
    if data.get("type") != expected_type:
        raise ValueError("Invalid WebAuthn ceremony type")
    if not hmac.compare_digest(str(data.get("challenge", "")), expected_challenge):
        raise ValueError("WebAuthn challenge mismatch")
    if data.get("origin") not in expected_origins:
        raise ValueError("WebAuthn origin mismatch")
    return raw


def _cose_to_public_key(cose: dict) -> dict:
    if not isinstance(cose, dict):
        raise ValueError("Invalid COSE key")
    kty = cose.get(1)
    alg = cose.get(3)
    if kty == 2 and alg == -7:
        if cose.get(-1) != 1:
            raise ValueError("Unsupported EC curve")
        x = cose.get(-2)
        y = cose.get(-3)
        if not isinstance(x, bytes) or not isinstance(y, bytes) or len(x) != 32 or len(y) != 32:
            raise ValueError("Invalid EC P-256 coordinates")
        ec.EllipticCurvePublicNumbers(
            int.from_bytes(x, "big"),
            int.from_bytes(y, "big"),
            ec.SECP256R1(),
        ).public_key()
        return {"kty": 2, "alg": -7, "crv": 1, "x": b64url_encode(x), "y": b64url_encode(y)}
    if kty == 3 and alg == -257:
        n = cose.get(-1)
        e = cose.get(-2)
        if not isinstance(n, bytes) or not isinstance(e, bytes) or len(n) < 128:
            raise ValueError("Invalid RSA key")
        rsa.RSAPublicNumbers(
            int.from_bytes(e, "big"),
            int.from_bytes(n, "big"),
        ).public_key()
        return {"kty": 3, "alg": -257, "n": b64url_encode(n), "e": b64url_encode(e)}
    raise ValueError("지원하지 않는 패스키 서명 알고리즘입니다 (ES256 또는 RS256 필요).")


def verify_registration(credential: dict, expected_challenge: str, expected_origins: set[str], rp_id: str) -> dict:
    if not isinstance(credential, dict):
        raise ValueError("Invalid WebAuthn credential")
    response = credential.get("response") or {}
    _verify_client_data(response.get("clientDataJSON", ""), "webauthn.create", expected_challenge, expected_origins)
    att_bytes = b64url_decode(response.get("attestationObject", ""))
    att, _ = cbor_decode(att_bytes)
    auth_data = att.get("authData") if isinstance(att, dict) else None
    if not isinstance(auth_data, bytes) or len(auth_data) < 55:
        raise ValueError("Invalid authenticator data")
    if not hmac.compare_digest(auth_data[:32], hashlib.sha256(rp_id.encode("utf-8")).digest()):
        raise ValueError("RP ID mismatch")
    flags = auth_data[32]
    if not (flags & 0x01) or not (flags & 0x40):
        raise ValueError("User presence or attested credential data missing")
    sign_count = int.from_bytes(auth_data[33:37], "big")
    cred_id_len = int.from_bytes(auth_data[53:55], "big")
    if 55 + cred_id_len >= len(auth_data):
        raise ValueError("Malformed attested credential")
    cred_id = auth_data[55:55 + cred_id_len]
    cose_key, _ = cbor_decode(auth_data[55 + cred_id_len:])
    pub_key = _cose_to_public_key(cose_key)
    cred_id_b64 = b64url_encode(cred_id)
    if credential.get("rawId") and not hmac.compare_digest(credential["rawId"], cred_id_b64):
        raise ValueError("Credential ID mismatch")
    return {
        "credential_id": cred_id_b64,
        "public_key": json.dumps(pub_key, separators=(",", ":")),
        "sign_count": sign_count,
    }


def verify_authentication(
    assertion: dict,
    stored_public_key: str,
    stored_sign_count: int,
    expected_challenge: str,
    expected_origins: set[str],
    rp_id: str,
) -> tuple[int, bool]:
    if not isinstance(assertion, dict):
        raise ValueError("Invalid WebAuthn assertion")
    response = assertion.get("response") or {}
    client_data_raw = _verify_client_data(
        response.get("clientDataJSON", ""), "webauthn.get", expected_challenge, expected_origins
    )
    auth_data = b64url_decode(response.get("authenticatorData", ""))
    signature = b64url_decode(response.get("signature", ""))
    if len(auth_data) < 37:
        raise ValueError("Invalid authenticator data")
    if not hmac.compare_digest(auth_data[:32], hashlib.sha256(rp_id.encode("utf-8")).digest()):
        raise ValueError("RP ID mismatch")
    flags = auth_data[32]
    if not (flags & 0x01):
        raise ValueError("User presence flag missing")
    uv = bool(flags & 0x04)
    sign_count = int.from_bytes(auth_data[33:37], "big")
    if stored_sign_count > 0 and sign_count > 0 and sign_count <= stored_sign_count:
        raise ValueError("Invalid passkey sign counter")

    signed_payload = auth_data + hashlib.sha256(client_data_raw).digest()
    pub = json.loads(stored_public_key)
    try:
        if pub["alg"] == -7:
            key = ec.EllipticCurvePublicNumbers(
                int.from_bytes(b64url_decode(pub["x"]), "big"),
                int.from_bytes(b64url_decode(pub["y"]), "big"),
                ec.SECP256R1(),
            ).public_key()
            key.verify(signature, signed_payload, ec.ECDSA(hashes.SHA256()))
        elif pub["alg"] == -257:
            key = rsa.RSAPublicNumbers(
                int.from_bytes(b64url_decode(pub["e"]), "big"),
                int.from_bytes(b64url_decode(pub["n"]), "big"),
            ).public_key()
            key.verify(signature, signed_payload, padding.PKCS1v15(), hashes.SHA256())
        else:
            raise ValueError("Unsupported stored passkey algorithm")
    except InvalidSignature as error:
        raise ValueError("패스키 서명 검증에 실패했습니다.") from error
    return sign_count, uv
