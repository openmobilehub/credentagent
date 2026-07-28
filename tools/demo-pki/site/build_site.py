#!/usr/bin/env python3
"""Build the CredentAgent demo-credential download site (static, Vercel-ready).

Emits site/index.html with the card art inlined as data URIs (so the page
renders on its own with no build step during review), and stages the actual
downloadable artifacts into site/credentials/, site/trust/, and site/certs/:

  ../out/*.mpzpass            -> site/credentials/
  ../out/utopia.vical|.rical  -> site/trust/
  ../certs/*.pem              -> site/certs/     (raw-cert fallback)

It also vendors the QR encoder (a site-local devDependency) into site/vendor/,
so each download renders a scannable QR the tester points their phone at.

QR codes must encode an ABSOLUTE URL (a phone camera can't resolve a relative
path), but index.html is committed and deployed to whatever origin the host
picks — so the QRs are rendered CLIENT-SIDE from `window.location` at page load
(deployment-agnostic, no build-time origin baked in). The download links
themselves are plain relative <a> tags and work with JavaScript off.

Each referenced file is checked for existence; anything not yet generated is
rendered as a disabled "not generated yet" chip rather than a broken link, so
the page never over-promises. Re-run after minting / building the trust lists.

Run:  npm install && python3 build_site.py     (from tools/demo-pki/site/)
Deps: Python stdlib only; the QR encoder is copied from node_modules (run
      `npm install` in this dir first — it is a site-local devDependency, NOT a
      dependency of the published @openmobilehub/credentagent-* packages).
"""
import base64
import os
import shutil
import sys
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
DEMO = os.path.dirname(HERE)               # tools/demo-pki
CARDART = os.path.join(DEMO, "cardart")
OUT = os.path.join(DEMO, "out")
CERTS = os.path.join(DEMO, "certs")
SITE_CREDS = os.path.join(HERE, "credentials")
SITE_TRUST = os.path.join(HERE, "trust")
SITE_CERTS = os.path.join(HERE, "certs")
SITE_VENDOR = os.path.join(HERE, "vendor")
QR_SRC = os.path.join(HERE, "node_modules", "qrcode-generator", "qrcode.js")

# ---- trust lists shown at the top (import these first) ----
TRUST = [
    dict(name="Issuer trust list (VICAL)", file="utopia.vical",
         dest="trust", src=os.path.join(OUT, "utopia.vical"),
         desc="Signed VICAL wrapping the Utopia demo IACA. Import this so the "
              "wallet trusts credentials issued under it."),
    dict(name="Reader trust list (RICAL)", file="utopia.rical",
         dest="trust", src=os.path.join(OUT, "utopia.rical"),
         desc="Signed RICAL wrapping the Utopia demo reader certificate, so a "
              "ceremony from this reader shows as a trusted verifier."),
]

# ---- raw certificates behind the trust lists (fallback for manual inspection
#      / import if the signed-list import path doesn't work on a device) ----
CERTS_FALLBACK = [
    dict(file="iaca-cert.pem", desc="Issuer root (IACA) — the anchor inside the VICAL."),
    dict(file="ds-cert.pem", desc="Document signer that signs each credential (chains to the IACA)."),
    dict(file="reader-cert.pem", desc="Reader leaf the gate presents — the anchor inside the RICAL."),
    dict(file="reader-root-cert.pem", desc="Reader root the reader leaf chains to."),
    dict(file="list-signer-cert.pem", desc="Signs the VICAL and RICAL themselves."),
]

# ---- credential cards ----
CREDS = [
    dict(title="Driver License (mDL)", art="card-mdl.png", file="mdl.mpzpass",
         doctype="org.iso.18013.5.1.mDL",
         desc="ISO mobile driving licence. Carries age_over_21=true and "
              "age_over_65=true, so one card satisfies both age gates."),
    dict(title="Digital Payment", art="card-payment.png", file="payment.mpzpass",
         doctype="org.multipaz.payment.sca.1",
         desc="Payment instrument for the amount-bound dc-payment gate. Carries "
              "the issuer-signed instrument claims; the amount is bound live at "
              "ceremony time by the wallet's device signature."),
    dict(title="Membership", art="card-membership.png", file="membership.mpzpass",
         doctype="org.multipaz.loyalty.1",
         desc="Utopia loyalty membership (membership_number + tier) for the "
              "membership gate."),
    dict(title="Professional License", art="card-professional.png",
         file="professional-license.mpzpass", doctype="org.example.license.1",
         desc="Licensed-trade credential (license_active=true)."),
]


def data_uri(path):
    if not os.path.exists(path):
        return None
    with open(path, "rb") as f:
        return "data:image/png;base64," + base64.b64encode(f.read()).decode()


def vendor_qr():
    """Copy the QR encoder from node_modules into vendor/ (a build output).
    Fail loudly with a fix hint if `npm install` hasn't run — never emit a page
    whose QRs silently don't render."""
    if not os.path.exists(QR_SRC):
        sys.exit(
            "error: QR encoder not found at node_modules/qrcode-generator/qrcode.js\n"
            "       run `npm install` in tools/demo-pki/site/ first "
            "(it is a site-local devDependency)."
        )
    os.makedirs(SITE_VENDOR, exist_ok=True)
    shutil.copy2(QR_SRC, os.path.join(SITE_VENDOR, "qrcode.js"))


def stage(items):
    """Copy existing trust artifacts into the site dir; return present set."""
    present = set()
    os.makedirs(SITE_TRUST, exist_ok=True)
    for it in items:
        if os.path.exists(it["src"]):
            shutil.copy2(it["src"], os.path.join(SITE_TRUST, it["file"]))
            present.add(it["file"])
    return present


def stage_creds():
    present = set()
    os.makedirs(SITE_CREDS, exist_ok=True)
    for c in CREDS:
        src = os.path.join(OUT, c["file"])
        if os.path.exists(src):
            shutil.copy2(src, os.path.join(SITE_CREDS, c["file"]))
            present.add(c["file"])
    return present


def stage_certs():
    present = set()
    os.makedirs(SITE_CERTS, exist_ok=True)
    for c in CERTS_FALLBACK:
        src = os.path.join(CERTS, c["file"])
        if os.path.exists(src):
            shutil.copy2(src, os.path.join(SITE_CERTS, c["file"]))
            present.add(c["file"])
    return present


def qr_box(rel_href, present):
    """A QR placeholder the client script fills from window.location + rel_href.
    (Empty when the artifact isn't staged, so we never QR a dead link.)"""
    if not present:
        return ""
    return f'<div class="qr" data-qr="{rel_href}" aria-label="QR code to open on a phone"></div>'


def dl_chip(href, label, present):
    if present:
        return f'<a class="dl" href="{href}" download>&#8681; {label}</a>'
    return f'<span class="dl off" title="run the pipeline to generate this">{label} — not generated yet</span>'


def render():
    vendor_qr()
    trust_present = stage(TRUST)
    creds_present = stage_creds()
    certs_present = stage_certs()

    trust_rows = []
    for t in TRUST:
        href = f'./trust/{t["file"]}'
        present = t["file"] in trust_present
        trust_rows.append(f"""
      <div class="trow">
        <div class="tmeta">
          <div class="tname">{t['name']}</div>
          <div class="tdesc">{t['desc']}</div>
          <code>{t['file']}</code>
          {dl_chip(href, 'Download', present)}
        </div>
        {qr_box(href, present)}
      </div>""")

    cert_links = []
    for c in CERTS_FALLBACK:
        if c["file"] not in certs_present:
            continue
        cert_links.append(
            f'<li><a href="./certs/{c["file"]}"><code>{c["file"]}</code></a> — {c["desc"]}</li>'
        )
    certs_block = (
        f"""
    <details class="certs">
      <summary>Raw certificates (fallback)</summary>
      <p>The PEM certificates the signed lists above wrap. You don't need these
        for the normal import — use them only to inspect a certificate or import
        an anchor by hand if a device rejects the signed list.</p>
      <ul>{''.join(cert_links)}</ul>
    </details>"""
        if cert_links else ""
    )

    cards = []
    for c in CREDS:
        uri = data_uri(os.path.join(CARDART, c["art"]))
        img = (f'<img src="{uri}" alt="{c["title"]} card art">' if uri
               else '<div class="noart">card art missing</div>')
        href = f'./credentials/{c["file"]}'
        present = c["file"] in creds_present
        cards.append(f"""
      <article class="card">
        <div class="art">{img}</div>
        <div class="body">
          <h3>{c['title']}</h3>
          <p>{c['desc']}</p>
          <code>{c['doctype']}</code>
          <div class="cardfoot">
            {dl_chip(href, 'Download .mpzpass', present)}
            {qr_box(href, present)}
          </div>
        </div>
      </article>""")

    built = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    html = PAGE.format(
        trust="".join(trust_rows), certs=certs_block,
        cards="".join(cards), built=built)
    with open(os.path.join(HERE, "index.html"), "w") as f:
        f.write(html)

    print("wrote index.html")
    print("vendored:", os.path.relpath(os.path.join(SITE_VENDOR, "qrcode.js"), HERE))
    print("trust staged:", sorted(trust_present) or "(none — build VICAL/RICAL)")
    print("creds staged:", sorted(creds_present) or "(none — mint first)")
    print("certs staged:", sorted(certs_present) or "(none)")


PAGE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>CredentAgent — Demo Wallet Credentials</title>
<style>
  :root {{
    --bg:#0b1020; --panel:#141a2e; --panel2:#1b2340; --line:#2a3355;
    --ink:#eef2ff; --muted:#a6b0d0; --accent:#6ea8fe; --accent2:#8b5cf6;
    --ok:#34d399;
  }}
  * {{ box-sizing:border-box; }}
  body {{ margin:0; background:linear-gradient(180deg,#0b1020,#0a0e1c);
    color:var(--ink); font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; }}
  .wrap {{ max-width:940px; margin:0 auto; padding:40px 20px 80px; }}
  header h1 {{ font-size:30px; margin:0 0 6px; letter-spacing:-.02em; }}
  header p.lede {{ color:var(--muted); margin:0 0 20px; max-width:640px; }}
  .banner {{ background:#2a1f0b; border:1px solid #6b4e16; color:#f7d488;
    border-radius:12px; padding:12px 16px; font-size:14px; margin:0 0 28px; }}
  .banner b {{ color:#ffdf9e; }}
  h2 {{ font-size:14px; text-transform:uppercase; letter-spacing:.08em;
    color:var(--muted); margin:34px 0 12px; }}
  .trust {{ display:flex; flex-direction:column; gap:10px; }}
  .trow {{ display:flex; align-items:center; gap:16px; justify-content:space-between;
    background:var(--panel); border:1px solid var(--line); border-radius:12px; padding:14px 16px; }}
  .tname {{ font-weight:600; }}
  .tdesc {{ color:var(--muted); font-size:14px; margin:2px 0 6px; }}
  code {{ background:var(--panel2); border:1px solid var(--line); color:#c9d4ff;
    padding:2px 8px; border-radius:6px; font-size:12.5px; }}
  .grid {{ display:grid; grid-template-columns:repeat(2,1fr); gap:18px; }}
  .card {{ background:var(--panel); border:1px solid var(--line); border-radius:16px; overflow:hidden;
    display:flex; flex-direction:column; }}
  .art {{ background:#0a0e1c; }}
  .art img {{ display:block; width:100%; height:auto; }}
  .noart {{ padding:40px; text-align:center; color:var(--muted); }}
  .body {{ padding:16px 18px 20px; display:flex; flex-direction:column; gap:8px; }}
  .body h3 {{ margin:0; font-size:18px; }}
  .body p {{ margin:0; color:var(--muted); font-size:14px; }}
  .cardfoot {{ display:flex; align-items:center; justify-content:space-between; gap:12px; margin-top:6px; }}
  .dl {{ align-self:flex-start; background:linear-gradient(135deg,var(--accent),var(--accent2));
    color:#0a0e1c; font-weight:700; text-decoration:none; padding:9px 14px; border-radius:10px; font-size:14px; }}
  .dl.off {{ background:#232a44; color:var(--muted); font-weight:600; cursor:not-allowed; }}
  .trow .dl {{ white-space:nowrap; margin-top:6px; }}
  .qr {{ width:96px; height:96px; flex:none; background:#fff; border-radius:8px; padding:6px; }}
  .qr svg {{ display:block; width:100%; height:100%; }}
  .qr:empty {{ display:none; }}
  .cardfoot .qr {{ width:72px; height:72px; }}
  details.certs {{ margin-top:14px; color:var(--muted); font-size:14px; }}
  details.certs summary {{ cursor:pointer; color:var(--ink); }}
  details.certs p {{ margin:8px 0; }}
  details.certs ul {{ margin:6px 0 0; padding-left:18px; }}
  details.certs li {{ margin:5px 0; }}
  ol.steps {{ color:var(--muted); padding-left:20px; }}
  ol.steps li {{ margin:6px 0; }}
  ol.steps b {{ color:var(--ink); }}
  .adb {{ color:var(--muted); font-size:13px; margin-top:10px; }}
  .adb code {{ font-size:12px; }}
  footer {{ margin-top:40px; color:var(--muted); font-size:13px; border-top:1px solid var(--line); padding-top:16px; }}
  @media (max-width:640px) {{ .grid {{ grid-template-columns:1fr; }} }}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>CredentAgent — Demo Wallet Credentials</h1>
    <p class="lede">Load these into a Multipaz wallet on your phone to satisfy the
      CredentAgent consent gates cross-device. Import the trust lists first, then
      the credentials. On a phone, scan a QR; on a laptop, use the download link.</p>
  </header>

  <div class="banner">
    <b>Demo trust only.</b> These credentials are signed by a self-generated demo
    PKI (dev IACA / document signer), not a real issuer. The wire crypto is real;
    the <b>trust anchor is not</b> (trust level: presence-only-demo). Do not treat a
    passing gate as a real safety or payment control.
  </div>

  <h2>1 · Trust setup — add these first</h2>
  <p class="lede" style="margin-top:-4px">Import both lists before the credentials,
    so nothing shows a red "unknown issuer" or "unknown verifier" warning.</p>
  <div class="trust">{trust}</div>
  {certs}

  <h2>2 · Credentials</h2>
  <div class="grid">{cards}</div>

  <h2>3 · How to import (phone-first)</h2>
  <ol class="steps">
    <li>On the phone, open this page and — from section 1 — open the <b>VICAL</b>
      and <b>RICAL</b> (tap the QR target or the download link). Choose
      <b>Open with Multipaz Wallet</b> so the demo issuer and reader become trusted.</li>
    <li>Back here, open each <b>.mpzpass</b> the same way and confirm the card is
      added to the wallet.</li>
    <li>Run a CredentAgent ceremony; the matching card should satisfy the gate with
      no red trust warning.</li>
  </ol>
  <p class="adb"><b>adb fallback</b> (edge cases — a browser that won't hand the file
    to the wallet, or a headless test device): pull the file to the phone and open it
    explicitly, e.g. <code>adb push utopia.vical /sdcard/Download/</code> then open it
    from Files with the Multipaz wallet, or drive the wallet's import intent directly
    with <code>adb shell am start</code>.</p>

  <footer>Built {built}. Part of Open Mobile Hub · demo PKI, presence-only trust level.</footer>
</div>

<!-- QR codes are rendered client-side so index.html stays deployment-agnostic:
     the phone-scannable URL is resolved from THIS page's origin at load time. -->
<script src="./vendor/qrcode.js"></script>
<script>
  (function () {{
    if (typeof qrcode !== "function") return; // links still work without the QR enhancement
    document.querySelectorAll("[data-qr]").forEach(function (el) {{
      var abs = new URL(el.getAttribute("data-qr"), window.location.href).href;
      var qr = qrcode(0, "M");           // auto version, medium error correction
      qr.addData(abs);
      qr.make();
      el.innerHTML = qr.createSvgTag({{ cellSize: 4, margin: 1, scalable: true }});
      el.setAttribute("title", abs);      // hover shows the exact absolute URL
    }});
  }})();
</script>
</body>
</html>
"""


if __name__ == "__main__":
    render()
