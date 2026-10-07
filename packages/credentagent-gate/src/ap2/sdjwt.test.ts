// `@sd-jwt/core` reports every failure as one exception type, so `libraryRefusal` reads its
// message. Each case here makes the library fail for real and pins the code it maps to: a library
// upgrade that rewords a message turns a test red instead of silently changing what a caller
// switches on.
import { describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { libraryRefusal, sdJwtInstance } from "./sdjwt.js";

const pair = () => generateKeyPairSync("ec", { namedCurve: "P-256" });
const now = Math.floor(Date.now() / 1000);

async function failure(claims: Record<string, unknown>, opts: { verifyWith?: ReturnType<typeof pair>; tamper?: (t: string) => string } = {}): Promise<string> {
  const signer = pair();
  const token = await sdJwtInstance({ privateKey: signer.privateKey }).issue({ iat: now, ...claims } as never, { _sd: ["secret"] } as never);
  try {
    await sdJwtInstance({ publicKey: (opts.verifyWith ?? signer).publicKey }).verify((opts.tamper ?? ((t) => t))(token), { currentDate: now, skewSeconds: 60 } as never);
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error("expected the library to refuse");
}

describe("libraryRefusal — pinned against the library's real messages", () => {
  it("expired", async () => {
    expect(libraryRefusal(await failure({ secret: 1, exp: now - 3600 }))).toBe("expired");
  });

  it("not yet valid", async () => {
    expect(libraryRefusal(await failure({ secret: 1, nbf: now + 3600 }))).toBe("not-yet-valid");
  });

  it("a disclosure its signer never committed to", async () => {
    const forged = Buffer.from(JSON.stringify(["salt", "secret", 2])).toString("base64url");
    const message = await failure({ secret: 1 }, { tamper: (t) => `${t.split("~")[0]}~${forged}~` });
    expect(libraryRefusal(message)).toBe("disclosure");
  });

  it("a time claim that is not a number", async () => {
    expect(libraryRefusal(await failure({ secret: 1, exp: "tomorrow" }))).toBe("malformed");
  });

  it("a signature from another key", async () => {
    expect(libraryRefusal(await failure({ secret: 1 }, { verifyWith: pair() }))).toBe("signature");
  });

  it("an unknown message is a refusal, never a pass", () => {
    expect(libraryRefusal("something the library has never said")).toBe("signature");
  });
});
