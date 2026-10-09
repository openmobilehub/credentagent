"""Feed the gate's signed open payment mandate (out/open_payment.json, from repro.mjs) to the AP2
reference SDK's OWN constraint evaluators (vendored by fetch-ap2-ref.sh from
google-agentic-commerce/AP2 @ e1ea56db, code/sdk/python/ap2/sdk/constraints.py).

    python3 docs/reviews/2026-10-agent-purchases/repros/budget-units/repro.py

Only `payment.amount_range` and `payment.budget` are evaluated - the two constraints the claim is
about - so nothing else (payee SD digests, the reference digest) can muddy the answer.
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "ap2ref"))

from ap2.sdk.constraints import (  # noqa: E402  (reference SDK, unmodified)
    AmountRangeEvaluator,
    BudgetEvaluator,
    MandateContext,
)
from ap2.sdk.generated.open_payment_mandate import AmountRange, Budget  # noqa: E402
from ap2.sdk.generated.payment_mandate import PaymentMandate  # noqa: E402

with open(os.path.join(HERE, "out", "open_payment.json")) as f:
    open_payment = json.load(f)

raw_range = next(c for c in open_payment["constraints"] if c["type"] == "payment.amount_range")
raw_budget = next(c for c in open_payment["constraints"] if c["type"] == "payment.budget")
amount_range = AmountRange.model_validate(raw_range)
budget = Budget.model_validate(raw_budget)
print(f"gate signed: {raw_range}")
print(f"gate signed: {raw_budget}")


def closed(cents: int) -> PaymentMandate:
    return PaymentMandate.model_validate({
        "transaction_id": "x",
        "payee": {"id": "utopia", "name": "utopia"},
        "payment_amount": {"amount": cents, "currency": "USD"},
        "payment_instrument": {"id": "demo-instrument-0001", "type": "card"},
    })


print("\nAP2 reference SDK BudgetEvaluator (the human approved a $50 budget):")
for past, now in [(0, 450), (4900, 450), (100_000, 1_500), (498_500, 1_500), (499_000, 1_500)]:
    v = BudgetEvaluator(budget, MandateContext(total_amount=past, total_uses=1)).evaluate(closed(now))
    print(f"  past spend ${past/100:,.2f} + ${now/100:,.2f} → {'PASS' if not v else 'REFUSED: ' + v[0]}")

print("\nAP2 reference SDK AmountRangeEvaluator (the human approved $20 per purchase):")
for now in [1_500, 2_000, 2_001, 10_000]:
    v = AmountRangeEvaluator(amount_range).evaluate(closed(now))
    print(f"  payment ${now/100:,.2f} → {'PASS' if not v else 'REFUSED: ' + v[0]}")
