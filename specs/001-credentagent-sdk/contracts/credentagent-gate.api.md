# Contract: `@openmobilehub/attesto-gate` public API (v0.1)

The surface the implementation MUST satisfy and tests MUST exercise. TypeScript signatures are the contract.

## Client

```ts
export interface AttestoOptions {
  walletOrigin?: string;             // optional; defaults to http://localhost:<PORT|3000>. Warns (never throws)
  store?: VerificationStore;         // default: in-memory, keyed by order id
}

export class Attesto {
  constructor(opts: AttestoOptions);
  mount(app: ExpressApp): void;                                   // Context 2: ceremony routes + store
  requirements(order: GateOrder, policy: Step[]): VerificationManifestEntry[];   // Context 1: code→data
}
```

## Policy builders

```ts
export const age:        { over(minAge: number): Credential };
export const membership: { discount(percent: number): Credential };
export const payment:    { in(currency: string): Credential };

export function required(c: Credential): Step;
export function optional(c: Credential): Step;

// every Credential exposes a call-site conditional:
interface Credential { when(predicate: (order: GateOrder) => boolean): Credential; /* …fields per data-model */ }
```

## Extensibility

```ts
export function defineCredential(c: {
  id: string;
  request: DcqlQuery;
  verify: (claims: Record<string, unknown>) => boolean;
  effect: Effect;
  appliesTo?: (order: GateOrder) => boolean;
  ui: { label: string; action: string };
}): Credential;

export function dcql(spec: { docType: string; claims: string[] }): DcqlQuery; // concise sugar → full DCQL
export function gate(): Effect;
export function discount(opts: { percent?: number; amount?: number }): Effect;
export function authorize(): Effect;
```

## Output (serializable manifest)

```ts
export interface VerificationManifestEntry {
  credential: string;
  required: boolean;
  effect: "gate" | "discount" | "authorize";
  enforcedAt: "tool" | "checkout";                       // Principle VII — honesty carried in the type
  trust_level: "presence-only-demo" | "issuer-verified"; // matches the envelope's wire field (no regression)
  label: string;
  minAge?: number;
  discountPct?: number;
  approveUrl?: string;
}
```

## Retained (Mode-B / roadmap primitive — additive, do NOT break)

```ts
export function buildVerificationRequired(args: …): VerificationRequired;   // tested wire shape
export function isVerificationRequired(v: unknown): v is VerificationRequired;
export function ageDcql(): DcqlQuery;
export type TrustLevel = "presence-only-demo" | "issuer-verified";
// gated(handler, policy): kept as a deprecated shim for one minor version
```

## Contract tests (MUST exist)

1. **Serialization (Principle VI):** `JSON.stringify(requirements(order, policy))` round-trips; the result
   contains **no functions** and re-parses deeply equal.
2. **Conditional drop:** a non-alcohol cart ⇒ manifest has no `age` entry; add an `alcohol` line ⇒ `age`
   appears with `minAge: 21` and an `approveUrl` bound to that order id.
3. **Ordering:** payment-bearing entry resolves **last** even if declared earlier in the policy.
4. **Required vs optional:** `optional(membership)` never blocks; `required(age)` is present when applicable.
5. **Custom credential:** a `prescription` (`appliesTo` Rx) appears only for an Rx line; absent otherwise.
6. **MCP-layer surfacing + completion-path enforcement (Security inv. 1):** calling the `checkout` tool
   (in-memory transport) for an age-restricted, unverified cart returns **both** a `checkoutUrl` **and** a
   `requires` manifest whose `age` entry is `effect: "gate"`, `minAge: 21`, with an `approveUrl` bound to
   that order id. This is consolidated **Mode A**: Context 1 *surfaces* the requirement (awareness) — the
   `checkout` tool mints the link, it is not a completion path (there is no MCP place/settle tool; the only
   completion path is HTTP `place-order`). Enforcement is asserted **on that completion path**: a
   `place-order` for the still-unverified order is refused (403, `app.ts:81`) and stays refused if the gate
   is removed (a test that passes without the control is useless). A non-alcohol cart ⇒ no `age` entry.
7. **Type safety:** `age.over(21).in("usd")` is a compile error (builders are credential-specific).
8. **Honesty axes (Principle VII):** every manifest entry carries `enforcedAt` (`"tool" | "checkout"`) and
   `trust_level` (`"presence-only-demo"` in v0.1); the serialized manifest preserves both — no regression
   from the envelope's `trust_level`.

## Redefined / removed (breaking — package is 0.x, pre-release)

- **`Step` is redefined:** `{ credential: Credential (object); required }` (was `{ credential: string;
  required }`). The old string-based shape is gone, not aliased.
- **`requireCredential` / `optionalCredential` (string-based) are removed** in favour of `required(c)` /
  `optional(c)` over `Credential` objects (they were type-incompatible, so no drop-in alias). The existing
  `index.test.ts` assertions for the old shapes are migrated as part of the module split.
