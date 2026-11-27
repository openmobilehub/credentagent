// The README's "Permissions" snippet, as a test — "the example IS the DX test". This file is also
// typechecked by `tsc -p tsconfig.test.json` (the package build), so a README example that stops
// compiling against the real types fails the build, not a reader. Keep it in step with README.md.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPermissions } from "../agent.js";

afterEach(() => vi.unstubAllGlobals());

describe("README — Permissions", () => {
  it("tracks a permission, waits, and reads how the wait ended", async () => {
    const asked: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      asked.push(url);
      return new Response(JSON.stringify({ status: "authorized", trustLevel: "device-signed" }));
    });

    // ── README block ──
    const storeUrls: Record<string, string> = { beanbarn: "https://beanbarn.example" }; // your shops, by ids you choose
    const grantId = "g1";                                       // the id the shop gave the permission when it created it

    const permissions = createPermissions({
      // `wait()` calls this with what you gave to `track()`: `store` is `{ id: "beanbarn" }` (the shop), `grantId` is `"g1"`.
      // Answer what the shop says: { status, trustLevel? }, `status` being "pending", "authorized", "denied" or "revoked".
      read: async ({ store, grantId }) => (await fetch(`${storeUrls[store.id]}/agent/grants/${grantId}`)).json(),
    });

    const trackingId = await permissions.track({ store: { id: "beanbarn" }, grantId }); // same id every time for this pair
    const result = await permissions.wait(trackingId);                                 // holds up to 45 s
    // ── end README block ──

    expect(asked).toEqual(["https://beanbarn.example/agent/grants/g1"]);
    expect(result).toEqual({ ok: true, status: "authorized", trustLevel: "device-signed" });
    expect(await permissions.track({ store: { id: "beanbarn" }, grantId })).toBe(trackingId);
  });
});
