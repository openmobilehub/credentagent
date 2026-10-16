// A gate failure reduced to stable fingerprints, so a run can tell "main was already red here" from
// "this change broke it": lint "file rule", TypeScript "file(l,c): error TSnnnn", vitest
// "FAIL file > test". The checkout path is stripped so main's and the branch's outputs compare.

export const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

export function fingerprints(name, out, dir) {
  const text = stripAnsi(out).split(dir).join("");
  if (name === "lint") {
    const fps = [];
    let file = "";
    for (const line of text.split("\n")) {
      if (/^\/?\S+\.(m?[jt]sx?)$/.test(line.trim())) file = line.trim();
      const m = line.match(/^\s+(\d+):(\d+)\s+error\s+.*\s(\S+)$/);
      if (m) fps.push(`${file} ${m[3]}`); // no line:col — an edit above it would make main's own error look new
    }
    return fps;
  }
  if (name === "test") return [...new Set(text.match(/^\s*(FAIL|×)\s+.+$/gm)?.map((s) => s.trim().replace(/\s+\d+ms$/, "")) ?? [])];
  return [...new Set(text.match(/\S+\(\d+,\d+\): error TS\d+/g) ?? [])];
}
