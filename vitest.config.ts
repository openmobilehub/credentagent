import { defineConfig, configDefaults } from "vitest/config";

// Determinism for the supertest suites — many tests drive Express apps via
// `request(app)`, which binds a fresh ephemeral loopback server per call. Serializing
// test files + capping the fork pool removes ephemeral-port/event-loop contention (the
// "supertest flake"); the wider timeout + retry absorb residual environmental jitter.
// Neither weakens any assertion — a real regression fails all attempts.
export default defineConfig({
  // The storefront widget ships React component tests (.test.tsx). Use the automatic JSX runtime
  // so those files — and the source components they import — transpile without a manual
  // `import React`. Only affects files that actually contain JSX; plain .ts suites are untouched.
  esbuild: { jsx: "automatic", jsxImportSource: "react" },
  test: {
    // `spike/**` holds standalone design prototypes whose tests use Node's built-in
    // runner (`node --test`), NOT vitest — exclude them so `vitest run` doesn't try to
    // load a `node:test` file and fail with "No test suite found". Run them on demand:
    // `node --test spike/**/**.test.mjs`.
    exclude: [...configDefaults.exclude, "**/.worktrees/**", "**/.claude/worktrees/**", "spike/**"],
    testTimeout: 15000,
    poolOptions: { forks: { minForks: 1, maxForks: 2 } },
    fileParallelism: false,
    retry: 2,
  },
});
