// A gate failure reduced to fingerprints, so a run can tell "main was already red here" from "this
// change broke it": lint "file rule", TypeScript "file TSnnnn", vitest "FAIL file > test", node --test
// "✖ test". No line or column — an edit above main's own error would make it look new — so they are
// compared as COUNTS: a change may not add even one more of a kind main already has.

export const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

export function fingerprints(name, out, dir) {
  const text = stripAnsi(out).split(dir).join("");
  if (name === "lint") {
    const fps = [];
    let file = "";
    for (const line of text.split("\n")) {
      if (/^\/?\S+\.(m?[jt]sx?)$/.test(line.trim())) file = line.trim();
      const m = line.match(/^\s+\d+:\d+\s+error\s+.*\s(\S+)$/);
      if (m) fps.push(`${file} ${m[1]}`);
    }
    return fps;
  }
  if (name === "test") {
    // vitest: "FAIL file > test" / "× test 12ms"; node --test: "✖ test (1.2ms)" (spec) / "not ok 3 - test" (TAP).
    const lines = text.match(/^\s*(FAIL|×|✖)\s+.+$|^\s*not ok \d+ - .+$/gm) ?? [];
    return [...new Set(lines.map((s) => s.trim().replace(/^not ok \d+ - /, "✖ ").replace(/\s+\(?\d+(\.\d+)?ms\)?$/, "")))];
  }
  return [...(text.matchAll(/(\S+)\(\d+,\d+\): error (TS\d+)/g))].map((m) => `${m[1]} ${m[2]}`);
}

const counts = (fps) => fps.reduce((m, f) => m.set(f, (m.get(f) ?? 0) + 1), new Map());

/** True when every fingerprint in `fps` occurs on main at least as often (a multiset ⊆). */
export function withinBaseline(fps, baseline) {
  const base = counts(baseline);
  return [...counts(fps)].every(([f, n]) => (base.get(f) ?? 0) >= n);
}
