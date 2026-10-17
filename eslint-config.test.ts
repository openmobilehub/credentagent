// The ceremony-page lint rule (eslint.config.js): a bare JSON.stringify inside a page template
// can close its <script> (#330), so lint must flag it however it is wrapped (#343). Lints source
// text against the repo config, as `npm run lint` would see it under ceremony/.
import { describe, expect, it } from "vitest";
import { ESLint } from "eslint";

const eslint = new ESLint();
const PAGE = "packages/credentagent-gate/src/ceremony/credential-gate/page.ts";

async function scriptJsonErrors(code: string, filePath = PAGE) {
  const [result] = await eslint.lintText(code, { filePath });
  return (result?.messages ?? []).filter(
    (m) => m.ruleId === "no-restricted-syntax" && m.message.includes("scriptJson()"),
  );
}

describe("ceremony lint: JSON.stringify in a page template", () => {
  it("flags a wrapped call — ${JSON.stringify(x).replace(…)}", async () => {
    const code = 'export const page = (x: string) => `<script>const u = ${JSON.stringify(x).replace(/a/g, "b")};</script>`;\n';
    expect(await scriptJsonErrors(code)).toHaveLength(1);
  });

  it("flags a call nested in another call inside a template expression", async () => {
    const code = "export const page = (x: string) => `<script>const u = ${String(JSON.stringify(x))};</script>`;\n";
    expect(await scriptJsonErrors(code)).toHaveLength(1);
  });

  it("still flags the direct ${JSON.stringify(x)} form", async () => {
    const code = "export const page = (x: string) => `<script>const u = ${JSON.stringify(x)};</script>`;\n";
    expect(await scriptJsonErrors(code)).toHaveLength(1);
  });

  it("passes scriptJson(x) in a template and JSON.stringify outside any template", async () => {
    const code = [
      'import { scriptJson } from "../script-json.js";',
      "export const page = (x: string) => `<script>const u = ${scriptJson(x)};</script>`;",
      "export const body = (x: string) => JSON.stringify({ x });",
      "",
    ].join("\n");
    expect(await scriptJsonErrors(code)).toHaveLength(0);
  });

  it("does not apply to script-json.ts itself or to tests", async () => {
    const code = "export const page = (x: string) => `${JSON.stringify(x).replace(/a/g, \"b\")}`;\n";
    expect(await scriptJsonErrors(code, "packages/credentagent-gate/src/ceremony/script-json.ts")).toHaveLength(0);
    expect(await scriptJsonErrors(code, "packages/credentagent-gate/src/ceremony/credential-gate/page.test.ts")).toHaveLength(0);
  });
});
