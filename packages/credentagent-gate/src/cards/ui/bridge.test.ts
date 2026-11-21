import { describe, it, expect } from "vitest";
import { detectHost } from "./bridge";

describe("detectHost", () => {
  it("ChatGPT injects window.openai", () => {
    expect(detectHost({ openai: {}, self: 1, top: 2 })).toBe("chatgpt");
  });

  it("any other frame is an MCP Apps host, such as Claude", () => {
    expect(detectHost({ self: 1, top: 2 })).toBe("mcp");
  });

  it("a top-level browser tab is the preview", () => {
    const win = {};
    expect(detectHost({ self: win, top: win })).toBe("preview");
  });
});
