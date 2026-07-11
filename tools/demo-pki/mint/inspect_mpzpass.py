#!/usr/bin/env python3
"""Parse a .mpzpass and confirm: DS cert identity + disclosed mdoc claims."""
import sys, cbor2

path = sys.argv[1]
raw = open(path, "rb").read()
top = cbor2.loads(raw)

found_strings = set()
ds_cn = []
claims = {}  # elementIdentifier -> value

def is_cert_der(b):
    return isinstance(b, bytes) and len(b) > 200 and b[:1] == b"\x30"

def walk(x, depth=0):
    # unwrap CBOR tag 24 (embedded cbor) and re-parse
    if isinstance(x, cbor2.CBORTag):
        if x.tag == 24 and isinstance(x.value, bytes):
            try:
                walk(cbor2.loads(x.value), depth+1); return
            except Exception:
                pass
        walk(x.value, depth+1); return
    if isinstance(x, dict):
        # IssuerSignedItem shape: {'digestID':..,'elementIdentifier':str,'elementValue':..}
        if "elementIdentifier" in x:
            claims[x["elementIdentifier"]] = x.get("elementValue")
        for k, v in x.items():
            walk(k, depth+1); walk(v, depth+1)
    elif isinstance(x, (list, tuple)):
        for v in x:
            walk(v, depth+1)
    elif isinstance(x, str):
        found_strings.add(x)
    elif is_cert_der(x):
        # crude: pull printable CN-ish ASCII runs from the DER
        import re
        for m in re.findall(rb"[ -~]{6,}", x):
            s = m.decode("ascii", "replace")
            if "Utopia" in s or "Demo" in s:
                ds_cn.append(s)

walk(top)

print(f"== {path} ==")
print("top-level type:", type(top).__name__)
interesting = sorted(s for s in found_strings if
                     s.startswith("org.") or s.startswith("eu.") or "age_over" in s
                     or s in ("family_name","given_name","license_active",
                              "membership_number","payment_instrument_id","expiry_date"))
print("namespaces/doctypes/elements seen:", interesting)
print("cert ASCII runs (DS/IACA identity):", sorted(set(ds_cn)))
print("disclosed claims (identifier = value):")
for k in sorted(claims):
    v = claims[k]
    if isinstance(v, cbor2.CBORTag):
        v = f"tag{v.tag}({v.value})"
    print(f"   {k} = {v!r}")
