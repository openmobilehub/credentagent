// The signing link as a QR code the person scans with their phone (spec 015 FR-7): an SVG data URL.
// `uqr` has no dependencies and runs in Node and the browser alike (the card page's preview uses it too).
import { renderSVG } from "uqr";

export function qrDataUrl(text: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(renderSVG(text, { ecc: "M", border: 1 }))}`;
}
