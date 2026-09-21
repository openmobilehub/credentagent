# AP2 Increment 2 — Keys, SD-JWT issuance, and ONE verification door

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `packages/credentagent-gate/src/ap2/` the ability to mint and verify real AP2 mandates — an ES256 signing key the gate publishes, SD-JWT issuance for the four mandate types, and a single fail-closed verification door — so that increment 3 (the delegation chain) can be about the chain and nothing else.

**Architecture:** Five new files inside the existing `ap2/` directory, layered bottom-up: `keys.ts` (key custody + `did:web` publication) → `sdjwt.ts` (the ES256 / SD-JWT crypto primitives) → `jwt.ts` (compact JWS for the one payload AP2 carries as a plain JWT) → `issue.ts` (`Ap2Issuer`, the configure-once minting surface) → `verify.ts` (`verifyMandate`, the only door). Then the gate is wired: a new `mandateSigningKey` option, `/.well-known/did.json` served by `mount()`, and a `doctor()` error when the key is ephemeral. Finally the hand-rolled ES256 verifier already living in the intent-sign rail is folded onto the shared one.

**Tech Stack:** TypeScript (ESM, NodeNext), Node 20+, `node:crypto` (NOT `jose`) for ES256, `@sd-jwt/core` (already a dependency on the `feat/intent-sign-ap2` branch), vitest.

**Provenance:** `keys.ts`, `sdjwt.ts`, `jwt.ts`, `issue.ts`, `verify.ts` and `roundtrip.test.ts` already exist, reviewed and green, on the closed integration branch `origin/013-ap2-v2-wire-format` (PR #182). This increment **ports them forward** onto the current stack and adds the wiring and reconciliation #182 never had. Retrieve each file with the exact `git show` command given in its task — do not retype it from memory.

**Tracking issue:** [#194](https://github.com/openmobilehub/credentagent/issues/194) · Refs [#39](https://github.com/openmobilehub/credentagent/issues/39)

**Base branch:** `feat/intent-sign-ap2` (PR #189, itself stacked on PR #187). Branch name: `feat/194-ap2-issuer-verifier`. (An earlier attempt, `feat/39-ap2-issuer-verifier` / PR #191, was closed carrying 18 stray IDE and scratch files; its source files are salvaged here, its junk is not.)

---

## Global Constraints

Every task's requirements implicitly include this section.

- **ESM with NodeNext resolution.** Every relative import carries a `.js` extension, even from a `.ts` file.
- **ES256 over P-256, always.** `node:crypto`'s `sign`/`verify` with `dsaEncoding: "ieee-p1363"` — node's EC default is DER, which no JWS verifier accepts.
- **Synchronous key resolution.** `mount()` is synchronous. Resolving the signing key on a promise would let routes attach before the public key reaches `app.locals` — a race in the middle of a security check. Do not introduce `await` into key resolution.
- **The option is `mandateSigningKey`, never `signingKey`.** `gateSecret` is already the ceremony seams' *symmetric HMAC* secret; this is an *asymmetric private key* whose public half is published to the world. Two different keys under one name is how a config mistake becomes silent. (Spec 013, Decision 1 correction.)
- **No floats anywhere in a mandate payload.** Money is `{ amount: <integer>, currency: "USD" }` in ISO-4217 minor units, via `ap2/money.ts`.
- **Security invariant 2 still decides.** Nothing in `ap2/` may be read as price authority. Putting an amount into a mandate never makes it true; the catalog re-price is still the gate.
- **A test that would still pass with its control removed is not a useful test.** Every bypass test in this plan must be verified red-on-revert, by actually deleting the control and re-running.
- **Honesty:** a verified mandate means *the bytes were signed by the key named, it has not expired, and — when key-bound — the holder proved possession of the key its own `cnf` commits to*. It does **not** mean issuer-verified trust. `trust_level` does not change in this increment. Issuer trust is issue #14 and stays open.
- **DCO:** every commit uses `git commit -s`.
- **The real test run is the root one.** `npm test` at the repo root. A per-package run reads as green while another package is red (#184 / PR #186).

---

## File Structure

| File | Responsibility |
| --- | --- |
| `packages/credentagent-gate/src/ap2/keys.ts` *(new)* | Resolve the gate's mandate-signing key; `did:web` identifier; the DID document. Nothing else touches key material. |
| `packages/credentagent-gate/src/ap2/sdjwt.ts` *(new)* | The configured SD-JWT instance and the raw ES256 signer/verifier/KB-verifier + `digestToken`. Internal — callers use `issue.ts` / `verify.ts`. |
| `packages/credentagent-gate/src/ap2/jwt.ts` *(new)* | Compact JWS sign/verify for the merchant-signed UCP Checkout (`checkout_jwt`), the one AP2 payload that is a plain JWT. |
| `packages/credentagent-gate/src/ap2/issue.ts` *(new)* | `Ap2Issuer` — mint the four mandate types; `presentWithKeyBinding` — append a key-bound hop. |
| `packages/credentagent-gate/src/ap2/verify.ts` *(new)* | `verifyMandate` — THE door, one refusal vocabulary. Plus `openCheckoutPayload` and `peekVct`. |
| `packages/credentagent-gate/src/ap2/keys.test.ts` *(new)* | Key resolution, rejection of the wrong key shapes, DID document shape. |
| `packages/credentagent-gate/src/ap2/roundtrip.test.ts` *(new)* | The issue↔verify suite, including seven bypass tests. |
| `packages/credentagent-gate/src/types.ts` *(modify)* | `CredentAgentOptions.mandateSigningKey`. |
| `packages/credentagent-gate/src/client.ts` *(modify)* | Resolve the key at construction; expose `ap2` issuer; serve `/.well-known/did.json` from `mount()`; feed `doctor()`. |
| `packages/credentagent-gate/src/doctor.ts` *(modify)* | Error-level finding when the mandate key is ephemeral. |
| `packages/credentagent-gate/src/index.ts` *(modify)* | Public exports for the AP2 surface — they land here, with increment 2, because a type with no way to produce or check it is worse than no export. |
| `packages/credentagent-gate/src/ceremony/intent-sign/presentation.ts` *(modify)* | Drop its private `es256` helper; use `sdjwt.ts`'s. One ES256 implementation in the package. |

---

## Task 1: `keys.ts` — the signing key and its publication

**Files:**
- Create: `packages/credentagent-gate/src/ap2/keys.ts`
- Test: `packages/credentagent-gate/src/ap2/keys.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `SIGNING_ALG: "ES256"`, `KEY_FRAGMENT: "gate-signing-key"`
  - `interface PrivateJwkP256 { kty: "EC"; crv: "P-256"; x: string; y: string; d: string }`
  - `interface PublicJwkP256 { kty: "EC"; crv: "P-256"; x: string; y: string; alg?: string; kid?: string }`
  - `interface GateSigningKey { kid: string; issuer: string; privateKey: KeyObject; publicJwk: PublicJwkP256; ephemeral: boolean }`
  - `didWebFor(origin: string): string`
  - `resolveSigningKey(origin: string, hostKey?: PrivateJwkP256): GateSigningKey`
  - `importVerifyKey(jwk: PublicJwkP256): KeyObject`
  - `didDocument(key: GateSigningKey): Record<string, unknown>`

- [ ] **Step 1: Write the failing test**

Create `packages/credentagent-gate/src/ap2/keys.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createSign, generateKeyPairSync, verify as nodeVerify } from "node:crypto";
import { didDocument, didWebFor, importVerifyKey, KEY_FRAGMENT, resolveSigningKey, type PrivateJwkP256 } from "./keys.js";

function p256PrivateJwk(): PrivateJwkP256 {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return privateKey.export({ format: "jwk" }) as unknown as PrivateJwkP256;
}

describe("did:web identity", () => {
  it("keys on the authority, percent-encoded, with no path segments", () => {
    expect(didWebFor("https://shop.example")).toBe("did:web:shop.example");
    expect(didWebFor("https://shop.example/checkout?x=1")).toBe("did:web:shop.example");
    expect(didWebFor("http://localhost:3000")).toBe("did:web:localhost%3A3000");
  });
});

describe("resolving the mandate signing key", () => {
  it("uses a host-supplied key and reports it as stable", () => {
    const jwk = p256PrivateJwk();
    const key = resolveSigningKey("https://shop.example", jwk);

    expect(key.ephemeral).toBe(false);
    expect(key.issuer).toBe("did:web:shop.example");
    expect(key.kid).toBe(`did:web:shop.example#${KEY_FRAGMENT}`);
    expect(key.publicJwk).toMatchObject({ kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, alg: "ES256" });
    expect(key.publicJwk).not.toHaveProperty("d");
  });

  it("generates an ephemeral key when the host supplies none, and SAYS so", () => {
    const key = resolveSigningKey("https://shop.example");
    expect(key.ephemeral).toBe(true);
    expect(key.publicJwk.x).toBeTruthy();
  });

  // Fail-closed on key shape: a key we cannot sign ES256 with must be refused at
  // construction, not at the first mandate — by then a caller has shipped.
  it("refuses a key that is not EC P-256", () => {
    expect(() =>
      resolveSigningKey("https://shop.example", { kty: "RSA", crv: "P-256", x: "a", y: "b", d: "c" } as unknown as PrivateJwkP256),
    ).toThrow(/EC P-256/);
    expect(() =>
      resolveSigningKey("https://shop.example", { kty: "EC", crv: "P-384", x: "a", y: "b", d: "c" } as unknown as PrivateJwkP256),
    ).toThrow(/EC P-256/);
  });

  // BYPASS: handing the gate a PUBLIC jwk must not silently yield a key that cannot sign.
  it("refuses a public-only JWK (bypass)", () => {
    const { d: _omitted, ...publicOnly } = p256PrivateJwk();
    expect(() => resolveSigningKey("https://shop.example", publicOnly as PrivateJwkP256)).toThrow(/PRIVATE/);
  });

  it("round-trips: what resolveSigningKey signs, importVerifyKey verifies", () => {
    const key = resolveSigningKey("https://shop.example");
    const data = Buffer.from("mandate bytes", "utf-8");
    const sig = createSign("sha256").update(data).sign({ key: key.privateKey, dsaEncoding: "ieee-p1363" });
    expect(nodeVerify("sha256", data, { key: importVerifyKey(key.publicJwk), dsaEncoding: "ieee-p1363" }, sig)).toBe(true);
  });
});

describe("the DID document mount() serves", () => {
  it("publishes exactly one assertion key and never the private half", () => {
    const doc = didDocument(resolveSigningKey("https://shop.example", p256PrivateJwk()));

    expect(doc.id).toBe("did:web:shop.example");
    expect(doc.assertionMethod).toEqual([`did:web:shop.example#${KEY_FRAGMENT}`]);
    const methods = doc.verificationMethod as Array<{ id: string; type: string; publicKeyJwk: Record<string, unknown> }>;
    expect(methods).toHaveLength(1);
    expect(methods[0].type).toBe("JsonWebKey2020");
    expect(methods[0].publicKeyJwk).not.toHaveProperty("d");
    // `authentication` would over-state what this key is for — it issues mandates.
    expect(doc).not.toHaveProperty("authentication");
    expect(JSON.stringify(doc)).not.toContain('"d"');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd packages/credentagent-gate && npx vitest run src/ap2/keys.test.ts
```

Expected: FAIL — `Failed to resolve import "./keys.js"`.

- [ ] **Step 3: Retrieve the implementation**

```bash
git show origin/013-ap2-v2-wire-format:packages/credentagent-gate/src/ap2/keys.ts > packages/credentagent-gate/src/ap2/keys.ts
```

Then read the file top to bottom and confirm these four things, which the tests pin:
1. `resolveSigningKey` throws on `kty !== "EC"` or `crv !== "P-256"`.
2. It throws on a JWK with no `d`.
3. `publicJwk` is rebuilt field-by-field from `x`/`y` — it is never a spread of the private JWK, which would leak `d` into the DID document.
4. `didDocument` lists `assertionMethod` only.

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd packages/credentagent-gate && npx vitest run src/ap2/keys.test.ts
```

Expected: PASS, 7 tests.

- [ ] **Step 5: Verify the public-key bypass test is load-bearing**

Temporarily change `publicJwk` in the host-key branch of `resolveSigningKey` to `{ ...hostKey, alg: SIGNING_ALG, kid }`, then re-run. Expected: the "publishes exactly one assertion key and never the private half" test FAILS on `JSON.stringify(doc)).not.toContain('"d"')`. Revert the change.

- [ ] **Step 6: Commit**

```bash
git add packages/credentagent-gate/src/ap2/keys.ts packages/credentagent-gate/src/ap2/keys.test.ts && git commit -s -m "feat(ap2): the gate's mandate signing key, and the did:web document that publishes it"
```

---

## Task 2: `sdjwt.ts` + `jwt.ts` — the crypto layer

**Files:**
- Create: `packages/credentagent-gate/src/ap2/sdjwt.ts`
- Create: `packages/credentagent-gate/src/ap2/jwt.ts`
- Test: covered by Task 4's `roundtrip.test.ts`; this task adds no test file of its own.

**Interfaces:**
- Consumes: `importVerifyKey`, `PublicJwkP256` from Task 1.
- Produces:
  - from `sdjwt.ts`: `SD_HASH_ALG: "sha-256"`, `es256Signer(privateKey: KeyObject): Signer`, `es256Verifier(publicJwk: PublicJwkP256): Verifier`, `cnfKbVerifier: KbVerifier`, `sdJwtInstance(opts: { privateKey?: KeyObject; publicJwk?: PublicJwkP256; holderKey?: KeyObject }): SDJwtInstance<SdJwtPayload>`, `digestToken(token: string, alg?: string): string`
  - from `jwt.ts`: `signCompactJwt(payload: object, privateKey: KeyObject, kid: string): string`, `verifyCompactJwt<T>(token: string, publicJwk: PublicJwkP256): T | undefined`, `peekJwtHeader(token: string): Record<string, unknown> | undefined`

**Note on right-sizing:** these two files ship together because `jwt.ts` is 38 lines that import `sdjwt.ts`'s signer and verifier, and neither is independently observable — the first assertion about either is in Task 4. Splitting them would create a task with no test cycle.

- [ ] **Step 1: Confirm the dependency is present**

```bash
grep -n '"@sd-jwt/core"' packages/credentagent-gate/package.json
```

Expected: a `dependencies` entry (it arrived with PR #189). If it is missing, you are on the wrong base branch — stop and re-check.

- [ ] **Step 2: Retrieve both implementations**

```bash
git show origin/013-ap2-v2-wire-format:packages/credentagent-gate/src/ap2/sdjwt.ts > packages/credentagent-gate/src/ap2/sdjwt.ts
git show origin/013-ap2-v2-wire-format:packages/credentagent-gate/src/ap2/jwt.ts > packages/credentagent-gate/src/ap2/jwt.ts
```

- [ ] **Step 3: Read `sdjwt.ts` and confirm the three things that will bite later**

1. `es256Signer` and `es256Verifier` both pass `dsaEncoding: "ieee-p1363"`.
2. `es256Verifier` returns `false` inside a `catch` — it never throws, so a caller cannot mistake "could not check" for "inconclusive, carry on".
3. `cnfKbVerifier` reads the holder key from `payload.cnf.jwk` — the key the ISSUER committed to — and returns `false` when there is no P-256 `cnf`. It must never accept a key supplied alongside the signature.

- [ ] **Step 4: Typecheck**

```bash
cd packages/credentagent-gate && npx tsc --noEmit -p tsconfig.json
```

Expected: clean. If `@sd-jwt/core` type names (`Signer`, `Verifier`, `KbVerifier`, `SdJwtPayload`, `SDJwtInstance`) do not resolve, the installed version has drifted from `^0.20.1` — fix the import against the installed `.d.ts`, do not loosen the types to `any`.

- [ ] **Step 5: Commit**

```bash
git add packages/credentagent-gate/src/ap2/sdjwt.ts packages/credentagent-gate/src/ap2/jwt.ts && git commit -s -m "feat(ap2): the ES256 / SD-JWT crypto layer, and compact JWS for the merchant Checkout"
```

---

## Task 3: `issue.ts` — minting the four mandate types

**Files:**
- Create: `packages/credentagent-gate/src/ap2/issue.ts`
- Test: covered by Task 4's `roundtrip.test.ts`.

**Interfaces:**
- Consumes: `GateSigningKey`, `PublicJwkP256` (Task 1); `digestToken`, `sdJwtInstance`, `SD_HASH_ALG` (Task 2); `signCompactJwt` (Task 2); `VCT`, `Amount`, `Cnf`, `Merchant`, `PaymentInstrument`, `UcpCheckout`, `CheckoutConstraint`, `PaymentConstraint` from `./types.js` (already on the branch, from PR #187).
- Produces:
  - `DEFAULT_MANDATE_TTL_MS: number`
  - `interface IssuedMandate { token: string; digest: string }`
  - `interface IssuedCheckout extends IssuedMandate { checkoutJwt: string; checkoutHash: string }`
  - `class Ap2Issuer` with `constructor(key: GateSigningKey)`, `get publicJwk(): PublicJwkP256`, `get issuer(): string`, `checkout(args: { checkout: UcpCheckout; ttlMs?: number }): Promise<IssuedCheckout>`, `payment(args: { transactionId: string; payee: Merchant; amount: Amount; instrument: PaymentInstrument; riskData?: Record<string, unknown>; executionDate?: string; ttlMs?: number }): Promise<IssuedMandate>`, `openCheckout(args: { constraints: CheckoutConstraint[]; cnf: Cnf; exp: number }): Promise<IssuedMandate>`, `openPayment(args: { constraints: PaymentConstraint[]; cnf: Cnf; exp: number; payee?: Merchant; amount?: Amount; instrument?: PaymentInstrument }): Promise<IssuedMandate>`
  - `presentWithKeyBinding(args: { token: string; holderKey: KeyObject; aud: string; nonce: string }): Promise<string>`

- [ ] **Step 1: Retrieve the implementation**

```bash
git show origin/013-ap2-v2-wire-format:packages/credentagent-gate/src/ap2/issue.ts > packages/credentagent-gate/src/ap2/issue.ts
```

- [ ] **Step 2: Read it and confirm the four invariants it carries**

1. `openCheckout` refuses to mint without a `checkout.line_items` constraint, and `openPayment` without `payment.reference` — AP2's schema `contains` rule. An unbounded open mandate is never minted.
2. `presentWithKeyBinding` takes `aud` and `nonce` as **required** parameters. Neither may become optional; a constant for either defeats replay protection.
3. `checkout()` marks `checkout_jwt` selectively disclosable, so a downstream party can be shown the binding without the line items.
4. Nothing in the file decides a price or whether a spend is in bounds.

- [ ] **Step 3: Typecheck**

```bash
cd packages/credentagent-gate && npx tsc --noEmit -p tsconfig.json
```

Expected: clean. If a type from `./types.js` is missing, PR #187's `types.ts` is not in your base — stop and re-check the branch.

- [ ] **Step 4: Commit**

```bash
git add packages/credentagent-gate/src/ap2/issue.ts && git commit -s -m "feat(ap2): Ap2Issuer — mint the four AP2 mandate types with the gate's key"
```

---

## Task 4: `verify.ts` — THE verification door, with its bypass suite

**Files:**
- Create: `packages/credentagent-gate/src/ap2/verify.ts`
- Test: `packages/credentagent-gate/src/ap2/roundtrip.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–3.
- Produces:
  - `type MandateRefusalCode = "malformed" | "signature" | "unexpected-type" | "expired" | "not-yet-valid" | "key-binding" | "audience" | "nonce" | "checkout-unbound"`
  - `interface MandateRefusal { ok: false; code: MandateRefusalCode; detail?: string }`
  - `interface MandateVerdict<T> { ok: true; mandate: T; keyBound?: { aud: string; nonce: string } }`
  - `verifyMandate<T extends AnyMandate>(token: string, opts: { publicJwk: PublicJwkP256; expect?: Vct; audience?: string; nonce?: string; nowMs?: number }): Promise<VerifyResult<T>>`
  - `openCheckoutPayload(mandate: CheckoutMandate, publicJwk: PublicJwkP256, digest: (token: string) => string): Promise<{ ok: true; checkout: UcpCheckout } | MandateRefusal>`
  - `peekVct(token: string): Vct | undefined`

- [ ] **Step 1: Retrieve the test suite first, and run it red**

```bash
git show origin/013-ap2-v2-wire-format:packages/credentagent-gate/src/ap2/roundtrip.test.ts > packages/credentagent-gate/src/ap2/roundtrip.test.ts
cd packages/credentagent-gate && npx vitest run src/ap2/roundtrip.test.ts
```

Expected: FAIL — `Failed to resolve import "./verify.js"`.

- [ ] **Step 2: Retrieve the implementation**

```bash
git show origin/013-ap2-v2-wire-format:packages/credentagent-gate/src/ap2/verify.ts > packages/credentagent-gate/src/ap2/verify.ts
```

- [ ] **Step 3: Read it and confirm the one design decision that makes it fail-closed**

`hasKeyBinding` is read **structurally off the token** via `splitSdJwt(token).kbJwt` — never derived from what the caller asked for. Both directions refuse:
- token is key-bound but no `audience`/`nonce` supplied → refuse `key-binding`
- `audience`/`nonce` supplied but the token carries no KB-JWT → refuse `key-binding`

Deriving this from the verify result instead let a key-bound presentation pass as an ordinary mandate whenever the caller forgot an audience — a stolen presentation would then replay anywhere. This is the single most important line in the file.

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd packages/credentagent-gate && npx vitest run src/ap2/roundtrip.test.ts
```

Expected: PASS, 12 tests, of which 7 are bypass tests:
- a swapped cart whose digest no longer matches
- a mandate signed by another key
- an expired mandate
- the wrong mandate type
- a key-binding hop signed by a key the `cnf` does not name
- a replayed nonce and a wrong audience
- a key-bound token verified with no audience/nonce supplied

- [ ] **Step 5: Verify the bypass tests are load-bearing (do this properly — it is the point)**

Run each revert one at a time, re-running the suite, then restoring the file:

| Delete this control in `verify.ts` | Expected to fail |
| --- | --- |
| the `if (hasKeyBinding && (!opts.audience \|\| !opts.nonce))` refusal | "refuses a key-bound token when no audience/nonce was supplied" |
| the `kb.payload.aud !== opts.audience` / `nonce` re-check **and** the `expectedKeyBindingAudience` / `keyBindingNonce` options passed to `sdjwt.verify` | "refuses a replayed nonce and a wrong audience" |
| the `opts.expect && payload.vct !== opts.expect` refusal | "refuses the wrong mandate type" |
| the `nowSec >= exp` refusal | "refuses an expired mandate" |
| the `digest(mandate.checkout_jwt) !== mandate.checkout_hash` refusal in `openCheckoutPayload` | "refuses a swapped cart whose digest no longer matches" |

If any row does NOT fail when its control is deleted, that test is decorative — fix the test before moving on. Restore `verify.ts` with `git checkout -- packages/credentagent-gate/src/ap2/verify.ts` after each check.

- [ ] **Step 6: Run the whole root suite**

```bash
npm test
```

Expected: green, with 19 more tests than the base branch (7 from Task 1, 12 here).

- [ ] **Step 7: Commit**

```bash
git add packages/credentagent-gate/src/ap2/verify.ts packages/credentagent-gate/src/ap2/roundtrip.test.ts && git commit -s -m "feat(ap2): one verification door for AP2 mandates, fail-closed on every axis"
```

---

## Task 5: Wire it into the gate — the option, the DID route, the doctor finding

**Files:**
- Modify: `packages/credentagent-gate/src/types.ts` (add to `CredentAgentOptions`, near `gateSecret` at ~line 291)
- Modify: `packages/credentagent-gate/src/client.ts` (constructor ~line 87; `mount()`)
- Modify: `packages/credentagent-gate/src/doctor.ts` (`DoctorInput` ~line 37; `runDoctor` ~line 100)
- Test: `packages/credentagent-gate/src/doctor.test.ts` (extend), `packages/credentagent-gate/src/client.test.ts` (extend)

**Interfaces:**
- Consumes: `resolveSigningKey`, `didDocument`, `GateSigningKey`, `PrivateJwkP256` (Task 1); `Ap2Issuer` (Task 3).
- Produces:
  - `CredentAgentOptions.mandateSigningKey?: PrivateJwkP256`
  - `CredentAgent.ap2: Ap2Issuer` (public readonly)
  - `DoctorInput.ephemeralMandateKey: boolean`
  - a `GET /.well-known/did.json` route registered by `mount()`

- [ ] **Step 1: Write the failing tests**

Append to `packages/credentagent-gate/src/doctor.test.ts`:

```ts
describe("the mandate signing key", () => {
  const base = {
    walletOrigin: "https://shop.example",
    hasGateSecret: true,
    sharedVerificationStore: true,
    sharedOrderStores: true,
    env: {} as Record<string, string | undefined>,
  };

  // An ephemeral key is not a warning. Every mandate this process signed becomes
  // unverifiable the moment it restarts — including mandates already handed to a wallet.
  it("is an ERROR when the key was generated at boot", () => {
    const report = runDoctor({ ...base, ephemeralMandateKey: true });
    const finding = report.findings.find((f) => f.code === "ephemeral-mandate-key");
    expect(finding?.level).toBe("error");
    expect(finding?.fix).toMatch(/mandateSigningKey/);
    expect(report.ok).toBe(false);
  });

  it("says nothing when the host supplied a stable key", () => {
    const report = runDoctor({ ...base, ephemeralMandateKey: false });
    expect(report.findings.some((f) => f.code === "ephemeral-mandate-key")).toBe(false);
  });
});
```

Append to `packages/credentagent-gate/src/client.test.ts`:

```ts
describe("the published mandate key", () => {
  it("serves a DID document whose key matches the issuer, and never the private half", () => {
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const jwk = privateKey.export({ format: "jwk" }) as unknown as PrivateJwkP256;
    const credentagent = new CredentAgent({ walletOrigin: "https://shop.example", mandateSigningKey: jwk });

    const routes: Array<[string, (req: unknown, res: { json: (b: unknown) => void }) => void]> = [];
    const app = { locals: {}, get: (path: string, handler: never) => routes.push([path, handler]), use: () => {}, post: () => {} };
    credentagent.mount(app as never);

    const route = routes.find(([path]) => path === "/.well-known/did.json");
    expect(route, "mount() must serve /.well-known/did.json").toBeDefined();

    let body: Record<string, unknown> | undefined;
    route![1]({}, { json: (b) => (body = b as Record<string, unknown>) });

    expect(body?.id).toBe("did:web:shop.example");
    expect(credentagent.ap2.issuer).toBe("did:web:shop.example");
    expect(JSON.stringify(body)).not.toContain('"d"');
  });
});
```

Add the imports these need at the top of each file: `generateKeyPairSync` from `node:crypto`, and `PrivateJwkP256` from `./ap2/keys.js`.

- [ ] **Step 2: Run both to verify they fail**

```bash
cd packages/credentagent-gate && npx vitest run src/doctor.test.ts src/client.test.ts
```

Expected: FAIL — `ephemeral-mandate-key` finding not found; `/.well-known/did.json` route undefined.

- [ ] **Step 3: Add the option**

In `packages/credentagent-gate/src/types.ts`, import the key type and add to `CredentAgentOptions` immediately after `gateSecret`:

```ts
  /**
   * The gate's AP2 mandate-signing key — a PRIVATE P-256 JWK, read from a secret manager.
   *
   * DISTINCT from {@link CredentAgentOptions.gateSecret}, which is a SYMMETRIC HMAC secret for
   * challenge tokens. This one is asymmetric and its public half is published to the world at
   * `/.well-known/did.json`, so anyone can verify a mandate this gate signed.
   *
   * Omit for local dev and the gate generates an ephemeral key — `doctor()` reports that as an
   * ERROR, because every mandate this process signed becomes unverifiable when it restarts.
   */
  mandateSigningKey?: PrivateJwkP256;
```

- [ ] **Step 4: Resolve the key in the constructor and expose the issuer**

In `packages/credentagent-gate/src/client.ts`, add the field next to `readonly grants`:

```ts
  /** Mints and publishes AP2 mandates with this gate's key (spec 013). */
  readonly ap2: Ap2Issuer;
```

and a private field beside `hasGateSecret`:

```ts
  private readonly mandateKey: GateSigningKey;
```

In the constructor, after `origin` is resolved:

```ts
    this.mandateKey = resolveSigningKey(origin, opts.mandateSigningKey);
    this.ap2 = new Ap2Issuer(this.mandateKey);
```

with the import `import { didDocument, resolveSigningKey, type GateSigningKey } from "./ap2/keys.js";` and `import { Ap2Issuer } from "./ap2/issue.js";`.

- [ ] **Step 5: Serve the DID document from `mount()`**

In `mount()`, alongside the existing route wiring, before `mountCeremony(...)`:

```ts
    // Publish the mandate-signing key. Without it the signature is checkable only by us,
    // which would make "real signatures" a hollow claim.
    if (typeof (app as { get?: unknown }).get === "function") {
      const doc = didDocument(this.mandateKey);
      (app as unknown as { get: (p: string, h: (req: unknown, res: { json: (b: unknown) => void }) => void) => void })
        .get("/.well-known/did.json", (_req, res) => res.json(doc));
    }
```

- [ ] **Step 6: Add the doctor finding**

In `doctor.ts`, add to `DoctorInput`:

```ts
  /** Was the AP2 mandate-signing key generated at boot (no `mandateSigningKey` supplied)? */
  ephemeralMandateKey?: boolean;
```

and inside `runDoctor`, before the `return`:

```ts
  if (input.ephemeralMandateKey) {
    findings.push({
      level: "error",
      code: "ephemeral-mandate-key",
      message:
        "The AP2 mandate-signing key was generated at boot. Every mandate this process signs becomes unverifiable when it restarts — including ones already handed to a wallet.",
      fix: "Pass `new CredentAgent({ mandateSigningKey })` with a stable private P-256 JWK from your secret manager.",
    });
  }
```

Pass it through from `client.ts`'s `doctor()` call: `ephemeralMandateKey: this.mandateKey.ephemeral`.

- [ ] **Step 7: Run the tests to verify they pass**

```bash
cd packages/credentagent-gate && npx vitest run src/doctor.test.ts src/client.test.ts
```

Expected: PASS.

- [ ] **Step 8: Verify the doctor finding is load-bearing**

Change `level: "error"` to `level: "warn"` and re-run. Expected: the "is an ERROR when the key was generated at boot" test fails on both `level` and `report.ok`. Revert.

- [ ] **Step 9: Run the root suite and commit**

```bash
npm test && npm run build
```

```bash
git add packages/credentagent-gate/src && git commit -s -m "feat(gate): mandateSigningKey, the did:web document mount() serves, and an ephemeral-key error"
```

---

## Task 6: One ES256 implementation, and the public exports

**Files:**
- Modify: `packages/credentagent-gate/src/ceremony/intent-sign/presentation.ts` (its private `es256` helper, ~line 47)
- Modify: `packages/credentagent-gate/src/index.ts`
- Test: existing `presentation.test.ts` must stay green unchanged; add the export assertion below.

**Interfaces:**
- Consumes: `es256Verifier` (Task 2); the AP2 surface from Tasks 1–4.
- Produces: the public AP2 exports listed in Step 3.

**Why this task exists:** `presentation.ts` (PR #189) hand-rolls an ES256 verifier because `sdjwt.ts` did not exist when it was written. Two ES256 implementations in one package is two places for the `ieee-p1363` detail to be got wrong, and only one of them is covered by the round-trip suite. PR #187 also deferred the public exports to "the issuer/verifier increment" — that is this one.

- [ ] **Step 1: Replace the private helper**

In `presentation.ts`, delete the local `es256` function and the `nodeVerify` / `utf8` declarations it used, and call the shared verifier instead. The shared one takes a JWK, not a `KeyObject`, so convert at the two call sites:

```ts
import { es256Verifier } from "../../ap2/sdjwt.js";
import type { PublicJwkP256 } from "../../ap2/keys.js";

const jwkOf = (key: ReturnType<typeof createPublicKey>): PublicJwkP256 => key.export({ format: "jwk" }) as unknown as PublicJwkP256;
```

Issuer-signature call site:

```ts
  if (!es256Verifier(jwkOf(issuerKey))(`${issuerHeader}.${issuerBody}`, issuerSig ?? "")) {
    return { ok: false, reason: "credential signature does not verify against its own certificate" };
  }
```

Key-binding call site:

```ts
  if (!es256Verifier(jwkOf(holderKey))(`${kbHeader}.${kbBody}`, kbSig ?? "")) {
    return { ok: false, reason: "key-binding signature does not verify against the credential's cnf key" };
  }
```

- [ ] **Step 2: Run the rail's suite to verify nothing moved**

```bash
cd packages/credentagent-gate && npx vitest run src/ceremony/intent-sign/
```

Expected: PASS, with the same test count as before the change. All four of PR #189's bypass tests must still pass — in particular "the key binding is signed by a key the credential does not name in `cnf`" and "the presentation carries no key binding at all". If either flips, the conversion lost the verification, not just the helper.

- [ ] **Step 3: Add the public exports**

In `packages/credentagent-gate/src/index.ts`:

```ts
// The AP2 wire format (spec 013). Exported now rather than with `types.ts` alone, because a
// mandate type with no way to produce or check one would be worse than no public API at all.
export { Ap2Issuer, presentWithKeyBinding, DEFAULT_MANDATE_TTL_MS } from "./ap2/issue.js";
export type { IssuedMandate, IssuedCheckout } from "./ap2/issue.js";
export { verifyMandate, openCheckoutPayload, peekVct } from "./ap2/verify.js";
export type { MandateRefusal, MandateRefusalCode, MandateVerdict, VerifyResult, VerifyOptions } from "./ap2/verify.js";
export { didWebFor, didDocument, resolveSigningKey, SIGNING_ALG } from "./ap2/keys.js";
export type { GateSigningKey, PrivateJwkP256, PublicJwkP256 } from "./ap2/keys.js";
export { amountFrom, amountsEqual, sumAmounts, toMinorUnits, toMajorUnits, formatAmount, exponentFor } from "./ap2/money.js";
export { VCT, findConstraint } from "./ap2/types.js";
export type * from "./ap2/types.js";
```

Do **not** export `sdjwt.ts` or `jwt.ts`. They are the crypto layer; a caller reaching past `issue.ts` / `verify.ts` is a caller building a second verification door.

- [ ] **Step 4: Assert the boundary in a test**

Append to `packages/credentagent-gate/src/client.test.ts`:

```ts
it("publishes the AP2 surface but not the crypto layer under it", async () => {
  const api = await import("./index.js");
  expect(api).toHaveProperty("Ap2Issuer");
  expect(api).toHaveProperty("verifyMandate");
  expect(api).toHaveProperty("toMinorUnits");
  // Reaching past issue/verify is how a second verification door gets built.
  expect(api).not.toHaveProperty("sdJwtInstance");
  expect(api).not.toHaveProperty("es256Signer");
  expect(api).not.toHaveProperty("signCompactJwt");
});
```

- [ ] **Step 5: Run everything**

```bash
npm test && npm run build
```

```bash
cd packages/credentagent-gate && npx eslint src/ap2/ src/ceremony/intent-sign/
```

Expected: all green.

- [ ] **Step 6: Update the gate README**

`packages/credentagent-gate/README.md` is published documentation and must match the API surface (CLAUDE.md, Conventions). Add a short section under the existing configuration docs:

```markdown
### AP2 mandates

The gate signs [AP2](https://github.com/google-agentic-commerce/AP2) mandates as SD-JWTs with
an ES256 key, and publishes the public half at `/.well-known/did.json` so anyone can verify one.

```js
const credentagent = new CredentAgent({
  walletOrigin: "https://shop.example",
  mandateSigningKey: JSON.parse(process.env.MANDATE_SIGNING_KEY), // a private P-256 JWK
});
```

Omit `mandateSigningKey` for local dev and the gate generates one at boot — `credentagent.doctor()`
reports that as an error, because those mandates stop verifying when the process restarts.

A verified mandate means the bytes were signed by the key named, it has not expired, and — when
key-bound — the holder proved possession of the key its own `cnf` commits to. It does **not** mean
the credential behind it came from a real issuer; that is issue #14 and still open.
```

- [ ] **Step 7: Commit and open the PR**

```bash
git add packages/credentagent-gate && git commit -s -m "feat(ap2): publish the AP2 surface, and fold the rail onto the shared ES256 verifier"
```

```bash
git push -u origin feat/194-ap2-issuer-verifier
```

Open the PR against `feat/intent-sign-ap2`, following `.github/pull_request_template.md`: plain language above the divider, technical detail below, every cross-reference spelled out. State in the body that this is increment 2 of 3 and that it should be retargeted to `main` as the stack merges.

---

## Definition of done

- [ ] `npm test` at the repo root is green, with 20+ more tests than the base branch.
- [ ] `npm run build` is clean in both workspaces; `eslint` is clean on `src/ap2/`.
- [ ] Every bypass test in Task 4 Step 5 and Task 5 Step 8 verified red-on-revert.
- [ ] `packages/credentagent-gate/README.md` describes `mandateSigningKey` and the DID route.
- [ ] No claim anywhere that a verified mandate implies issuer-verified trust.
- [ ] Every commit carries `Signed-off-by:`.

## What this increment deliberately does NOT do

Named so a reviewer does not read them as gaps:

- **The delegation chain.** `~~` serialization, `sd_hash` / `issuer_jwt_hash` hop binding, constraint evaluation with "unknown constraint MUST fail" — that is increment 3 (spec 014 FR-3/FR-4), and `chain.ts` / `transport.ts` on `origin/013-ap2-v2-wire-format` are its starting point.
- **The agent-side key split.** `K_s` still lives in the merchant's process. Spec 014 FR-5.
- **A distinct merchant key.** `checkout_jwt` is signed with the gate's own key here; the `kid` makes the future swap visible. Spec 014 FR-6.
- **Retiring the ceremony's own mandate code.** `ceremony/mandate.ts` is untouched; the migration to AP2 mandates is expand → migrate → contract, and this is the expand.
- **Issuer trust.** Issue #14, unchanged.
