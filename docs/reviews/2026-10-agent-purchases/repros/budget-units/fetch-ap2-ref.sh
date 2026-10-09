#!/usr/bin/env bash
# Vendor the AP2 reference SDK's constraint evaluator (google-agentic-commerce/AP2, pinned commit)
# so repro.py can run the REAL BudgetEvaluator / AmountRangeEvaluator against the gate's output.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
D="$HERE/ap2ref"
REF=e1ea56db72a6385bce3e5c1112b3a56ce60acb43   # AP2 main HEAD as of 2026-10-08 (v0.2 release line)
FILES="__init__.py constraints.py max_flow_helper.py
generated/__init__.py generated/open_checkout_mandate.py generated/open_payment_mandate.py
generated/payment_mandate.py generated/types/__init__.py generated/types/amount.py
generated/types/checkout.py generated/types/merchant.py generated/types/item.py
generated/types/line_item.py generated/types/link.py generated/types/buyer.py
generated/types/total.py generated/types/jwk.py generated/types/payment_instrument.py
generated/types/pisp.py generated/types/message.py generated/types/message_error.py
generated/types/message_info.py generated/types/message_warning.py"
mkdir -p "$D/ap2"
: > "$D/ap2/__init__.py"
for p in $FILES; do
  mkdir -p "$D/ap2/sdk/$(dirname "$p")"
  gh api "repos/google-agentic-commerce/AP2/contents/code/sdk/python/ap2/sdk/$p?ref=$REF" --jq .content | base64 -d > "$D/ap2/sdk/$p"
done
# The schema too, for the record.
mkdir -p "$HERE/spec"
for p in open_payment_mandate.json types/amount.json; do
  gh api "repos/google-agentic-commerce/AP2/contents/code/sdk/schemas/ap2/$p?ref=$REF" --jq .content | base64 -d > "$HERE/spec/$(basename "$p")"
done
echo "vendored $(find "$D" -name '*.py' | wc -l | tr -d ' ') files @ $REF"
