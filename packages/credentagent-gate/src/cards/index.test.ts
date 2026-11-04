// The card kit's exact wire values (spec 015). A server that types the spec's value instead of
// importing the constant must still match what the card page reads.
import { describe, it, expect } from "vitest";
import { GRANT_VIEW_KIND, REVOKE_TOOL_META } from "./index.js";

describe("@openmobilehub/credentagent-gate/cards", () => {
  it("carries the spec's exact values", () => {
    expect(GRANT_VIEW_KIND).toBe("credentagent.grant");
    expect(REVOKE_TOOL_META).toBe("credentagent/revokeTool");
  });
});
