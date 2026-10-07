// The dSD-JWT compact serialization (Delegate SD-JWT §5.1.1): links joined by `~~`, each link an
// SD-JWT with its own disclosures. These tests pin the wire shape a verifier written to the draft
// — or the AP2 Python SDK — will split on.
import { describe, expect, it } from "vitest";
import { DELEGATE_SD_JWT_REVISION, joinChain, splitChain, linkToString } from "./serialize.js";

const jwt = (n: number) => `h${n}.p${n}.s${n}`;

describe("the chain's compact serialization", () => {
  it("pins the draft revision it implements", () => {
    expect(DELEGATE_SD_JWT_REVISION).toBe("draft-gco-oauth-delegate-sd-jwt-00");
  });

  it("joins links with `~~` and ends a dSD-JWT with `~`", () => {
    const chain = joinChain([`${jwt(0)}~d0~d1~`, `${jwt(1)}~e0~`, `${jwt(2)}~f0~`]);
    expect(chain).toBe(`${jwt(0)}~d0~d1~~${jwt(1)}~e0~~${jwt(2)}~f0~`);
  });

  it("splits back into links, each with its own trailing `~`", () => {
    const links = splitChain(`${jwt(0)}~d0~~${jwt(1)}~e0~~${jwt(2)}~`);
    expect(links).toEqual([
      { jwt: jwt(0), disclosures: ["d0"] },
      { jwt: jwt(1), disclosures: ["e0"] },
      { jwt: jwt(2), disclosures: [] },
    ]);
  });

  it("round-trips", () => {
    const chain = `${jwt(0)}~d0~~${jwt(1)}~e0~e1~~${jwt(2)}~f0~`;
    expect(joinChain(splitChain(chain)!.map(linkToString))).toBe(chain);
  });

  // A chain of one link is just an SD-JWT, not a delegation: refusing it here keeps a plain
  // credential from being read as a chain whose hops were all "checked".
  it("refuses a single link, a trailing KB-JWT, an empty disclosure, and a non-JWT link", () => {
    expect(splitChain(`${jwt(0)}~d0~`)).toBeUndefined();
    expect(splitChain(`${jwt(0)}~~${jwt(1)}~${jwt(2)}`)).toBeUndefined(); // dSD-JWT+KB: not the AP2 shape
    expect(splitChain(`${jwt(0)}~d0~~~${jwt(1)}~`)).toBeUndefined();
    expect(splitChain(`${jwt(0)}~~notajwt~`)).toBeUndefined();
  });
});
