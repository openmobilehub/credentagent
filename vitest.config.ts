import { defineConfig, configDefaults } from "vitest/config";

// Determinism for the supertest suites — many tests drive Express apps via
// `request(app)`, which binds a fresh ephemeral loopback server per call. Serializing
// test files + capping the fork pool removes ephemeral-port/event-loop contention (the
// "supertest flake"); the wider timeout + retry absorb residual environmental jitter.
// Neither weakens any assertion — a real regression fails all attempts.
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "**/.worktrees/**", "**/.claude/worktrees/**"],
    testTimeout: 15000,
    poolOptions: { forks: { minForks: 1, maxForks: 2 } },
    fileParallelism: false,
    retry: 2,
  },
});
