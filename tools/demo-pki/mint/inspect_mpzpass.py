#!/usr/bin/env python3
"""Parse a .mpzpass and confirm: DS/IACA cert identity + disclosed mdoc claims.

A .mpzpass is ``["MpzPass", raw-deflate(CBOR)]`` — the credential CBOR is DEFLATE-
compressed (raw stream, no zlib/gzip header). We **inflate it first**, then walk
the mdoc structure. Walking the raw file without inflating finds nothing: the
payload is one opaque compressed blob, so claims/identity come back empty and a
perfectly good credential looks broken. Inflate is the whole trick.

Usage:  python3 inspect_mpzpass.py <file.mpzpass>
Deps:   cbor2  (pip install cbor2)  — zlib/re are stdlib.
"""
import sys, re, zlib, cbor2

path = sys.argv[1]
raw = open(path, "rb").read()
top = cbor2.loads(raw)


def inflate_payload(top):
    """Return (inner_bytes, inner_cbor, inflated?) for a .mpzpass wrapper.

    The wrapper is ["MpzPass", <bytes>]; the bytes are raw-deflate CBOR. Try raw
    deflate first (wbits=-15, what MpzPass uses), then zlib/gzip as a courtesy,
    then fall back to treating the file as plain CBOR (so the tool still says
    something useful on a non-wrapped input rather than crashing)."""
    if (isinstance(top, (list, tuple)) and len(top) == 2
            and top[0] == "MpzPass" and isinstance(top[1], bytes)):
        for wbits in (-15, 15, 47):   # raw-deflate, zlib, gzip
            try:
                inner = zlib.decompress(top[1], wbits)
                return inner, cbor2.loads(inner), True
            except Exception:
                continue
    # not the compressed wrapper — inspect the top-level structure directly
    return raw, top, False


inner_bytes, root, inflated = inflate_payload(top)

found_strings = set()
claims = {}  # elementIdentifier -> value


def walk(x):
    # unwrap CBOR tag 24 (embedded cbor) and re-parse
    if isinstance(x, cbor2.CBORTag):
        if x.tag == 24 and isinstance(x.value, bytes):
            try:
                walk(cbor2.loads(x.value)); return
            except Exception:
                pass
        walk(x.value); return
    if isinstance(x, dict):
        # IssuerSignedItem shape: {'digestID':..,'elementIdentifier':str,'elementValue':..}
        if "elementIdentifier" in x:
            claims[x["elementIdentifier"]] = x.get("elementValue")
        for k, v in x.items():
            walk(k); walk(v)
    elif isinstance(x, (list, tuple)):
        for v in x:
            walk(v)
    elif isinstance(x, str):
        found_strings.add(x)


walk(root)

# Cert identity (IACA / DS / reader CNs) — pulled from the inflated bytes, where
# the x5chain DER certs live. The subject CNs are printable ASCII inside the DER.
identity = sorted(set(re.findall(r"Utopia Demo [A-Za-z ]+", inner_bytes.decode("latin-1"))))
identity = [s.strip() for s in identity]

print(f"== {path} ==")
print("payload:", "inflated MpzPass CBOR" if inflated else "walked as-is (not a MpzPass wrapper?)")
interesting = sorted(s for s in found_strings if
                     s.startswith("org.") or s.startswith("eu.") or "age_over" in s
                     or s in ("family_name", "given_name", "license_active",
                              "membership_number", "payment_instrument_id", "expiry_date"))
print("namespaces/doctypes/elements seen:", interesting)
print("cert identity (IACA/DS/reader CNs):", identity)
print("disclosed claims (identifier = value):")
for k in sorted(claims):
    v = claims[k]
    if isinstance(v, cbor2.CBORTag):
        v = f"tag{v.tag}({v.value})"
    print(f"   {k} = {v!r}")
