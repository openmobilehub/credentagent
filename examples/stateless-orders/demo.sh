#!/usr/bin/env bash
# Drive a full stateless checkout against the example server (start it first:
#   node examples/stateless-orders/server.mjs
# then in another terminal:  bash examples/stateless-orders/demo.sh ).
set -euo pipefail
BASE="${BASE:-http://localhost:4000}"
ORDER="ORD-1"

echo "① mint a signed cart mandate (a real host does this when it creates the order)"
ISSUE="$(curl -s "$BASE/issue?order=$ORDER")"
CART="$(printf '%s' "$ISSUE" | python3 -c 'import json,sys;print(json.load(sys.stdin)["cart"])')"
echo "   cart param length: ${#CART} chars (this is the whole signed cart on the wire)"
echo

echo "② GET the gate page — order reconstructed from ?cart, NO order-store read"
CODE="$(curl -s -o /dev/null -w '%{http_code}' "$BASE/attestomcp/dc-payment?order=$ORDER&cart=$CART")"
echo "   HTTP $CODE  (200 = the empty/throwing store was never touched)"
echo

echo "③ POST verify with the cart mandate in the body → completes through the shared seam"
MANDATE="$(printf '%s' "$ISSUE" | python3 -c 'import json,sys;print(json.dumps(json.load(sys.stdin)["mandate"]))')"
BODY="$(python3 -c 'import json,sys;m=json.loads(sys.argv[1]);print(json.dumps({"order":"'"$ORDER"'","cartMandate":m,"claims":{"issuer_name":"Demo Bank","payment_instrument_id":"pi-77AABBCC","holder_name":"Demo Buyer","expiry_date":"2032-09-01"}}))' "$MANDATE")"
curl -s "$BASE/attestomcp/dc-payment/verify" -H 'content-type: application/json' -d "$BODY" \
  | python3 -m json.tool
echo
echo "④ (optional) BYPASS check — tamper the cart, expect completed:false"
TBODY="$(python3 -c 'import json,sys;m=json.loads(sys.argv[1]);m["lines"]=[{"id":"aurora-headphones","quantity":10,"unitPrice":199,"lineTotal":1990}];print(json.dumps({"order":"'"$ORDER"'","cartMandate":m,"claims":{"issuer_name":"x"}}))' "$MANDATE")"
curl -s "$BASE/attestomcp/dc-payment/verify" -H 'content-type: application/json' -d "$TBODY" \
  | python3 -c 'import json,sys;r=json.load(sys.stdin);print("   tampered →", {"completed":r.get("completed"),"error":r.get("error")})'
