// The README's "Permissions" snippet, as a test — "the example IS the DX test". This file is also
// typechecked by `tsc -p tsconfig.test.json` (the package build), so a README example that stops
// compiling against the real types fails the build, not a reader. Keep it in step with README.md.
import { describe, expect, it } from "vitest";
import { createPermissions } from "../agent.js";

describe("README — Permissions", () => {
  it("tracks a permission, waits, and reads how the wait ended", async () => {
    const storeUrls: Record<string, string> = { beanbarn: "https://beanbarn.example" };
    const grantId = "g1";
    const asked: string[] = [];
    const getJson = async (url: string) => {
      asked.push(url);
      return { status: "authorized" as const, trustLevel: "device-signed" };
    };

    // ── README block ──
    const permissions = createPermissions({
      read: ({ store, grantId }) => getJson(`${storeUrls[store.id]}/agent/grants/${grantId}`),
    });

    const trackingId = await permissions.track({ store: { id: "beanbarn" }, grantId });
    const result = await permissions.wait(trackingId);
    // ── end README block ──

    expect(asked).toEqual(["https://beanbarn.example/agent/grants/g1"]);
    expect(result).toEqual({ ok: true, status: "authorized", trustLevel: "device-signed" });
    expect(await permissions.track({ store: { id: "beanbarn" }, grantId })).toBe(trackingId);
  });
});
