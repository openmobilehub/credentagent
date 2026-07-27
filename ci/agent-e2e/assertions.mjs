// Shared, provider-agnostic assertions for the agent-in-the-loop E2E. Both harnesses (Claude via
// the Anthropic SDK, ChatGPT via the OpenAI Responses API) normalize their provider's tool trace
// into { toolNames, rawOutputs, finalText } and call runAssertions — ONE source of truth for what
// "an agent could actually use these tools" means, so the two stay in lockstep.
//
// The manifest checks match a WHITESPACE-NORMALIZED concatenation of the raw tool outputs, not
// parsed JSON. Two provider quirks make parsing fragile: (1) providers re-serialize tool results
// differently (OpenAI pretty-prints — `"credential": "age"` with a space), so a match on compact
// JSON silently misses; (2) providers can truncate a long tool output, so `JSON.parse` throws and
// the whole result vanishes even though the tokens are present. Stripping whitespace and substring-
// matching compact tokens is robust to both — as long as the token appears anywhere in the output.
//
// Known-gap vs regression: today a headless agent often dead-ends at `browse-products` because it
// exposes no product ids in text (tracked as #120), though it sometimes guesses a slug and proceeds.
// When it never even reaches the cart, that's the KNOWN gap — we warn (exit 0) rather than hard-fail,
// so the nightly stays a live signal instead of a permanently-red check. A NEW regression — can't use
// tools at all, fabricates a completion, or (having reached the cart) loses checkout / the age gate /
// the honesty label — DOES hard-fail. When #120 lands and the agent reliably reaches checkout, the
// full checkout-path checks apply automatically.

// `strictManifest`: whether to COUNT the manifest-content checks (age gate, honesty label) as
// regressions. True for a provider whose tool trace is returned in full (Anthropic). False for one
// that truncates long tool outputs in the returned trace (OpenAI's hosted MCP caps them, so the
// checkout manifest — bloated by base64 approve-URLs — is often cut off). For a lossy-trace
// provider the manifest checks are reported for visibility but not counted; the COUNTED guarantee is
// tool-drivability + no fabricated completion, which is what that harness can prove reliably.
export function runAssertions({ toolNames, rawOutputs, finalText, mcpUrl, model, strictManifest = true }) {
  // Whitespace-normalized blob of every tool output → compact-token substring matching.
  const blob = (rawOutputs ?? []).map((s) => String(s ?? "").replace(/\s+/g, "")).join("\n");
  const has = (token) => blob.includes(token);

  const lc = toolNames.map((n) => n.toLowerCase());
  const usedTools = toolNames.length > 0;
  const reachedCart = lc.some((n) => n.includes("add-to-cart"));
  const reachedCheckout = lc.some((n) => n.includes("checkout"));
  // The #120 signature: the agent used tools but never got an item into the cart. (If it CALLED
  // add-to-cart and still failed to check out, that's a real regression — the strict branch runs.)
  const knownDiscoveryGap = usedTools && !reachedCart;

  const ageGateReached = has('"credential":"age"') && has('"minAge":21');
  const honestyLabelIntact = has('"trust_level":"presence-only-demo"');
  const noFakeCompletion = !has('"completed":true') && !has('"status":"completed"');
  const toldHumanAboutAge = /\b21\b|age/i.test(finalText);

  let failures = 0;
  const check = (label, cond, { detail = "", regression = true } = {}) => {
    console.log(`${cond ? "✓" : regression ? "✗" : "•"} ${label}${cond || !detail ? "" : ` — ${detail}`}`);
    if (!cond && regression) failures++;
  };

  console.log(`\nagent-e2e against ${mcpUrl} (model ${model})`);
  console.log(`tool calls: ${toolNames.join(" → ") || "(none)"}\n`);

  // Always-meaningful invariants — a failure here is a genuine regression regardless of the gap.
  check("the agent could use the store at all (≥1 MCP tool call)", usedTools);
  check("no tool result claimed the gated order completed (nothing to hallucinate from)", noFakeCompletion);

  if (knownDiscoveryGap) {
    console.log(
      "\n⚠ KNOWN GAP (openmobilehub/credentagent#120): the agent used tools but couldn't get an item\n" +
        "  into the cart — browse-products withholds product ids from headless agents, so there is\n" +
        "  nothing for it to act on. Tracked, NOT counted as a regression; the checkout-path checks\n" +
        "  below are reported for visibility only and light up green once #120 lands.",
    );
    check("the agent reached checkout unaided", reachedCheckout, { regression: false });
    check("the age gate reached the agent (credential=age, minAge=21)", ageGateReached, { regression: false });
    check("the honesty label survived to the agent-facing wire (presence-only-demo)", honestyLabelIntact, { regression: false });
    check("the agent told the human about the 21+ requirement", toldHumanAboutAge, { regression: false });
  } else {
    // The agent got at least to the cart — checkout itself must succeed (always counted). The
    // manifest-content checks are counted only when the provider returns the tool trace in full.
    check("the agent reached checkout unaided", reachedCheckout);
    if (!strictManifest) {
      console.log(
        "  (this provider truncates long tool outputs in the returned trace, so the manifest checks\n" +
          "   below are reported for visibility but NOT counted — the age gate is asserted end-to-end\n" +
          "   by the full-trace provider's harness.)",
      );
    }
    check("the age gate reached the agent (credential=age, minAge=21)", ageGateReached, { regression: strictManifest });
    check("the honesty label survived to the agent-facing wire (presence-only-demo)", honestyLabelIntact, { regression: strictManifest });
    check("the agent told the human about the 21+ requirement", toldHumanAboutAge, { regression: strictManifest, detail: "final message never mentioned the age requirement" });
  }

  console.log(`\n[dx] tool calls: ${toolNames.length}`);
  if (failures === 0) {
    console.log(knownDiscoveryGap ? "\nNO REGRESSIONS (known gap #120 still open — see warning above)" : "\nALL AGENT-E2E CHECKS PASSED");
  } else {
    console.log(`\n${failures} REGRESSION(S) — the agent-facing contract broke`);
    if (finalText) console.log("\n--- final agent message (for debugging) ---\n" + finalText.slice(0, 1500));
  }
  return failures;
}
