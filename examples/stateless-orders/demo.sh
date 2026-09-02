#!/usr/bin/env bash
# Drive a full stateless checkout against the example server (start it first:
#   node examples/stateless-orders/server.mjs
# then in another terminal:  bash examples/stateless-orders/demo.sh ).
set -euo pipefail
BASE="${BASE:-http://localhost:4000}"
ORDER="ORD-1"

echo "⓪ the gate publishes the key anyone can verify these mandates with"
curl -s "$BASE/.well-known/did.json" | python3 -c 'import json,sys;d=json.load(sys.stdin);print("  ", d["id"], "→", d["verificationMethod"][0]["id"])'
echo

echo "① mint a signed AP2 chain (a real host does this when it creates the order)"
ISSUE="$(curl -s "$BASE/issue?order=$ORDER")"
CHAIN="$(printf '%s' "$ISSUE" | python3 -c 'import json,sys;print(json.load(sys.stdin)["chain"])')"
echo "   chain param length: ${#CHAIN} chars (Checkout + Payment Mandate, both SD-JWTs)"
echo

echo "② GET the gate page — order reconstructed from ?chain, NO order-store read"
CODE="$(curl -s -o /dev/null -w '%{http_code}' "$BASE/credentagent/dc-payment?order=$ORDER&chain=$CHAIN")"
echo "   HTTP $CODE  (200 = the empty/throwing store was never touched)"
echo

echo "③ POST verify with the chain in the body → completes through the shared seam"
MANDATES="$(printf '%s' "$ISSUE" | python3 -c 'import json,sys;print(json.dumps(json.load(sys.stdin)["mandates"]))')"
BODY="$(python3 -c 'import json,sys;m=json.loads(sys.argv[1]);print(json.dumps({"order":"'"$ORDER"'","chain":m,"claims":{"issuer_name":"Demo Bank","payment_instrument_id":"pi-77AABBCC","holder_name":"Demo Buyer","expiry_date":"2032-09-01"}}))' "$MANDATES")"
curl -s "$BASE/credentagent/dc-payment/verify" -H 'content-type: application/json' -d "$BODY" \
  | python3 -m json.tool
echo
echo "④ BYPASS check — flip one byte of the signed Checkout Mandate, expect completed:false"
TBODY="$(python3 -c '
import json,sys
m = json.loads(sys.argv[1])
jwt, _, rest = m["checkout"].partition("~")
head, body, sig = jwt.split(".")
m["checkout"] = ".".join([head, body, ("A" if sig[0] != "A" else "B") + sig[1:]]) + "~" + rest
print(json.dumps({"order":"'"$ORDER"'","chain":m,"claims":{"issuer_name":"x"}}))' "$MANDATES")"
curl -s "$BASE/credentagent/dc-payment/verify" -H 'content-type: application/json' -d "$TBODY" \
  | python3 -c 'import json,sys;r=json.load(sys.stdin);print("   tampered →", {"completed":r.get("completed"),"error":r.get("error")})'
