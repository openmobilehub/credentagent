// The ISO 18013-5 doctype / namespace / data-elements the org-iso-mdoc (iOS
// WebKit) path requests. The OpenID4VP (Android Chrome) path forwards the richer
// DCQL directly; the iOS DeviceRequest carries one `docRequest` per credential
// (item 6 — a multi-credential DCQL is no longer truncated to the first). Kept
// aligned with dcql.ts so a wallet satisfies either path from the same credential(s).
import type { MdocDocSpec } from "../mdoc/mdoc-iso.js";
import type { CredentialKind } from "./dcql.js";
import type { DcqlQuery } from "../../types.js";
import { claimLeaf } from "../../credentials.js";

export function mdocDocSpec(kind: CredentialKind, minimumAge = 21): MdocDocSpec {
  if (kind === "age") {
    return {
      docType: "org.iso.18013.5.1.mDL",
      namespace: "org.iso.18013.5.1",
      // Ask for the over-age boolean AT the threshold (plus 18, as `ageDcql` does on the
      // OpenID4VP path); verify.ts requires the explicit positive at THIS threshold, so a
      // 25+ policy must ask for `age_over_25` or no iPhone wallet could ever prove it.
      elements: minimumAge > 18 ? [`age_over_${minimumAge}`, "age_over_18"] : ["age_over_18"],
    };
  }
  return {
    docType: "org.multipaz.loyalty.1",
    namespace: "org.multipaz.loyalty.1",
    elements: ["membership_number", "tier"],
  };
}

/**
 * Derive the ISO org-iso-mdoc doc spec for ONE credential option of a CUSTOM credential's
 * `request` DcqlQuery — the `dcql()` sugar builds claim paths as `[docType, leaf]`, so the
 * doctype is the option's `meta.doctype_value` and the namespace matches it (the same
 * convention the loyalty doctype above uses), with the requested claim leaves as data
 * elements. `mdocDocSpecsFromDcql` maps this over every option so the iOS DeviceRequest and
 * the richer OpenID4VP DCQL stay aligned to the same doctype definitions — no second source
 * of truth.
 */
function specFromDcqlCredential(cred: DcqlQuery["credentials"][number]): MdocDocSpec {
  const docType = cred?.meta?.doctype_value ?? cred?.id ?? "";
  const elements = (cred?.claims ?? []).map((c) => claimLeaf(c.path)).filter((e): e is string => typeof e === "string");
  return { docType, namespace: docType, elements };
}

/** One iOS org-iso-mdoc doc spec PER credential option in the DCQL (item 6 — the iOS
 *  DeviceRequest carries one docRequest each, so a multi-credential DCQL is no longer
 *  truncated to `credentials[0]` on the iOS path the way it was before). */
export function mdocDocSpecsFromDcql(dcql: DcqlQuery): MdocDocSpec[] {
  return dcql.credentials.map(specFromDcqlCredential);
}
