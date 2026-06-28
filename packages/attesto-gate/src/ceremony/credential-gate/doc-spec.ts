// The ISO 18013-5 doctype / namespace / data-elements the org-iso-mdoc (iOS
// WebKit) path requests per credential kind. The OpenID4VP (Android Chrome) path
// uses the richer DCQL in dcql.ts (which can offer several doctypes); this is the
// single ISO doctype the iOS DeviceRequest carries, since that protocol asks one
// doctype at a time. Kept aligned with dcql.ts so a wallet satisfies either path
// from the same credential.
import type { MdocDocSpec } from "../mdoc/mdoc-iso.js";
import type { CredentialKind } from "./dcql.js";

export function mdocDocSpec(kind: CredentialKind, minimumAge = 21): MdocDocSpec {
  if (kind === "age") {
    return {
      docType: "org.iso.18013.5.1.mDL",
      namespace: "org.iso.18013.5.1",
      // Ask for the over-age booleans bracketing the threshold; verify.ts requires
      // the explicit positive at THIS threshold (a sub-threshold proof is refused).
      elements: minimumAge >= 21 ? ["age_over_21", "age_over_18"] : ["age_over_18"],
    };
  }
  return {
    docType: "org.multipaz.loyalty.1",
    namespace: "org.multipaz.loyalty.1",
    elements: ["membership_number", "tier"],
  };
}
