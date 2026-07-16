// Lint layer — the mechanically-checkable slice of SECURITY-INVARIANTS.md
// (REVIEW.md §0). Deliberately NO style preset: every rule here encodes a domain
// rule a reviewer would otherwise re-catch by hand on each PR. Add a rule when a
// review finding recurs; each rule's message names the invariant it guards.
import tsParser from "@typescript-eslint/parser";

// Invariant 4: verification/cart state is keyed per order/session — never
// process-global. A module-level mutable binding or container is one shared slot
// per process, so one user's verification would unlock everyone's checkout.
// The sanctioned in-memory default lives behind the injectable VerificationStore
// (class-private Map), which these selectors do not match.
const moduleGlobalState = [
  {
    selector: "Program > VariableDeclaration[kind='let'], Program > ExportNamedDeclaration > VariableDeclaration[kind='let']",
    message:
      "Module-level `let` is process-global state (SECURITY-INVARIANTS.md #4): key it per order/session via VerificationStore.",
  },
  {
    selector: "Program > VariableDeclaration[kind='var'], Program > ExportNamedDeclaration > VariableDeclaration[kind='var']",
    message:
      "Module-level `var` is process-global state (SECURITY-INVARIANTS.md #4): key it per order/session via VerificationStore.",
  },
  // A module-level Map/Set is allowed only when its binding is typed
  // ReadonlySet/ReadonlyMap — an immutable lookup table TS won't let you mutate —
  // e.g. RESERVED_CREDENTIAL_IDS in credentials.ts.
  {
    selector: "Program > VariableDeclaration > VariableDeclarator:not([id.typeAnnotation.typeAnnotation.typeName.name=/^Readonly(Map|Set)$/]) > NewExpression[callee.name=/^(Map|Set|WeakMap|WeakSet)$/], Program > ExportNamedDeclaration > VariableDeclaration > VariableDeclarator:not([id.typeAnnotation.typeAnnotation.typeName.name=/^Readonly(Map|Set)$/]) > NewExpression[callee.name=/^(Map|Set|WeakMap|WeakSet)$/]",
    message:
      "A module-level Map/Set is process-global state (SECURITY-INVARIANTS.md #4): key it per order/session via VerificationStore, or type the binding ReadonlySet/ReadonlyMap if it is an immutable lookup.",
  },
];

export default [
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "examples/**",
      "spike/**",
      ".worktrees/**",
      "worktrees/**",
    ],
  },

  // Both packages: no process-global mutable state (invariant 4). Tests are
  // excluded — fixtures may hold module-level state without a cross-user surface.
  {
    files: ["packages/*/src/**/*.ts"],
    ignores: ["**/*.test.ts"],
    languageOptions: { parser: tsParser },
    rules: {
      "no-restricted-syntax": ["error", ...moduleGlobalState],
    },
  },

  // Gate package (the security surface): randomness comes from node:crypto
  // (randomBytes / randomUUID). Math.random() is never crypto-safe; a nonce or
  // challenge built from it is predictable (adjacent to invariant 6).
  {
    files: ["packages/credentagent-gate/src/**/*.ts"],
    ignores: ["**/*.test.ts"],
    languageOptions: { parser: tsParser },
    rules: {
      "no-restricted-properties": [
        "error",
        {
          object: "Math",
          property: "random",
          message:
            "Math.random() is not crypto-safe: use randomBytes/randomUUID from node:crypto in the gate (SECURITY-INVARIANTS.md #6). A justified eslint-disable is required for cosmetic uses.",
        },
      ],
    },
  },

  // Ceremony rails and helpers: completion happens ONLY through the injected
  // ctx.completion seam so every rail reconciles against the same gates
  // (invariant 1). Rail tests exercise the seam directly and are excluded.
  {
    files: ["packages/credentagent-gate/src/ceremony/*/*.ts"],
    ignores: ["**/*.test.ts"],
    languageOptions: { parser: tsParser },
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/completion.js"],
              message:
                "A rail never imports completion.js — complete through the injected ctx.completion seam so every path runs the same gates (SECURITY-INVARIANTS.md #1).",
            },
          ],
        },
      ],
    },
  },
];
