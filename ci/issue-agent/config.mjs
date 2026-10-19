// What the issue agent needs to know about the repo it works on: how to install and build it, which
// gates to run, how to run a few test files, what counts as source, and what the agents should read.
//
// The repo says so in `.github/issue-agent.json` (README.md, "Using it in another repo"). It lives under
// .github/ on purpose: the agent never publishes a change there (checks.mjs, forbiddenPaths), so it can't
// loosen its own gates. Without the file, DEFAULT_CONFIG applies — exactly this repo's own setup.
//
// Every command is an argv array, run without a shell from the checkout's root. Patterns are regular
// expressions, as strings, matched against repo-relative paths.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const CONFIG_PATH = ".github/issue-agent.json";

export const DEFAULT_CONFIG = Object.freeze({
  // Run once per checkout, before anything else; null to skip.
  install: ["npm", "ci", "--no-audit", "--no-fund"],
  // Run after a checkout and around the test-proof check's revert; null when the repo has no build.
  build: ["npm", "run", "build"],
  // In order. Exactly one is named "test": the authoritative run publish requires on the final patch.
  gates: [
    { name: "build", cmd: ["npm", "run", "build"] },
    { name: "typecheck", cmd: ["npm", "run", "typecheck"] },
    { name: "lint", cmd: ["npm", "run", "lint"] },
    { name: "test", cmd: ["npm", "test"] },
  ],
  // How a fix attempt picks its quick tests: "vitest-workspaces" (each touched packages/<name>/), or
  // null to run the "test" gate's own command every time (fine for a small suite).
  fastTest: "vitest-workspaces",
  // Runs the given test files (appended): the test-proof check's "fails without the fix" run.
  testRunner: ["npx", "vitest", "run", "--retry=0"],
  testFile: "\\.test\\.[mc]?[jt]sx?$",
  // Source the test-proof check reverts to main (test files never count).
  source: "^(packages|examples|ci/issue-agent)/",
  sourceExclude: "\\.md$",
  // A line from the test output for the PR's gate summary (every distinct match, joined).
  testSummary: "Tests\\s+.+",
  // The commands a reviewer agent may run (Claude Code permission rules).
  checkTools: ["Bash(npx vitest *)", "Bash(npm test *)", "Bash(npm test)", "Bash(npm run build*)", "Bash(npm run typecheck*)", "Bash(npm run lint*)"],
  // Told to the agents and printed in the PR's "How to test".
  focusedTest: "npx vitest run <file>",
  reproduce: "npm ci && npm run build && npm test",
  // ── what the agents read (undefined → roles.mjs's own text, written for this repo) ──
  docs: ["CLAUDE.md", "REVIEW.md", "SECURITY-INVARIANTS.md"],
  audience: "a user of the library",
  implementNotes: undefined,
  lenses: undefined,
  reviewRules: undefined,
  serveHint: undefined,
  // "pause": the agents first post a brief (reproduction, how bad, the fix, the criteria) and build only
  // after a person approves it (README.md, "The brief"). "off": the label starts the build, as before.
  brief: "off",
});

const KINDS = {
  install: "cmd?", build: "cmd?", gates: "gates", fastTest: "fast", testRunner: "cmd", testFile: "re", source: "re",
  sourceExclude: "re?", testSummary: "re?", checkTools: "strings", focusedTest: "string", reproduce: "string",
  docs: "strings", audience: "string", implementNotes: "strings?", lenses: "lenses?", reviewRules: "string?", serveHint: "string?",
  brief: "brief",
};

const isCmd = (v) => Array.isArray(v) && v.length > 0 && v.every((s) => typeof s === "string" && s.length > 0);
const isStrings = (v) => Array.isArray(v) && v.every((s) => typeof s === "string" && s.length > 0);

/** The config with every field checked. Throws, naming the field, on anything it can't use. */
export function validateConfig(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${CONFIG_PATH} must be a JSON object`);
  const cfg = { ...DEFAULT_CONFIG };
  for (const [key, value] of Object.entries(raw)) {
    if (key === "$comment") continue;
    const kind = KINDS[key];
    if (!kind) throw new Error(`${CONFIG_PATH}: unknown field "${key}" (known: ${Object.keys(KINDS).join(", ")})`);
    const bad = (want) => { throw new Error(`${CONFIG_PATH}: "${key}" must be ${want}`); };
    const optional = kind.endsWith("?");
    if (optional && value === null) { cfg[key] = null; continue; }
    switch (kind.replace("?", "")) {
      case "cmd": if (!isCmd(value)) bad("a non-empty array of strings (argv, no shell)"); break;
      case "string": if (typeof value !== "string" || !value) bad("a non-empty string"); break;
      case "strings": if (!isStrings(value)) bad("an array of non-empty strings"); break;
      case "re": try { new RegExp(value); } catch (e) { bad(`a valid regular expression (${e.message})`); } if (typeof value !== "string") bad("a string"); break;
      case "fast": if (value !== null && value !== "vitest-workspaces") bad('"vitest-workspaces" or null'); break;
      case "brief": if (value !== "off" && value !== "pause") bad('"off" or "pause"'); break;
      case "lenses":
        if (!value || typeof value !== "object" || Object.entries(value).some(([k, v]) => !["spec", "security", "dx"].includes(k) || typeof v !== "string" || !v)) bad('an object whose keys are "spec", "security" or "dx" and whose values are non-empty strings');
        break;
      case "gates": {
        if (!Array.isArray(value) || !value.length) bad("a non-empty array");
        const names = new Set();
        for (const g of value) {
          if (!g || typeof g.name !== "string" || !/^[a-z][a-z0-9-]*$/.test(g.name) || !isCmd(g.cmd)) bad('a list of { "name": "lowercase-name", "cmd": ["argv", …] }');
          if (names.has(g.name)) bad(`a list with unique names ("${g.name}" repeats)`);
          names.add(g.name);
        }
        if (!names.has("test")) bad('a list that includes a gate named "test"');
        break;
      }
    }
    cfg[key] = value;
  }
  return Object.freeze(cfg);
}

/** The repo's config: its `.github/issue-agent.json` over the defaults, or the defaults alone. */
export function loadConfig(repoRoot) {
  const file = join(repoRoot, CONFIG_PATH);
  if (!existsSync(file)) return DEFAULT_CONFIG;
  let raw;
  try { raw = JSON.parse(readFileSync(file, "utf8")); } catch (e) { throw new Error(`${CONFIG_PATH} is not valid JSON: ${e.message}`); }
  return validateConfig(raw);
}

/** The "test" gate's command, as people type it ("npm test") — for logs, prompts and PR text. */
export const testLabel = (cfg = DEFAULT_CONFIG) => cfg.gates.find((g) => g.name === "test").cmd.join(" ");
/** Every gate in one line, as an agent should run them before finishing. */
export const checkCommand = (cfg = DEFAULT_CONFIG) => cfg.gates.map((g) => g.cmd.join(" ")).join(" && ");
