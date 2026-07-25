#!/usr/bin/env python3
"""Build the CredentAgent demo-credential download site (static, Vercel-ready).

Emits site/index.html with the card art inlined as data URIs (so the page
renders on its own with no build step during review), and stages the actual
downloadable artifacts into site/credentials/ and site/trust/:

  ../out/*.mpzpass            -> site/credentials/
  ../out/utopia.vical|.rical  -> site/trust/

Each referenced file is checked for existence; anything not yet generated is
rendered as a disabled "not generated yet" chip rather than a broken link, so
the page never over-promises. Re-run after minting / building the trust lists.

Run:  python3 build_site.py     (from tools/demo-pki/site/)
Deps: stdlib only.
"""
import base64
import os
import shutil
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
DEMO = os.path.dirname(HERE)               # tools/demo-pki
CARDART = os.path.join(DEMO, "cardart")
OUT = os.path.join(DEMO, "out")
SITE_CREDS = os.path.join(HERE, "credentials")
SITE_TRUST = os.path.join(HERE, "trust")

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


def stage(items):
    """Copy existing source artifacts into the site dir; return present set."""
    present = set()
    os.makedirs(SITE_CREDS, exist_ok=True)
    os.makedirs(SITE_TRUST, exist_ok=True)
    for it in items:
        src = it["src"]
        dest_dir = SITE_TRUST if it["dest"] == "trust" else SITE_CREDS
        if os.path.exists(src):
            shutil.copy2(src, os.path.join(dest_dir, it["file"]))
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


def dl_chip(href, label, present):
    if present:
        return f'<a class="dl" href="{href}" download>&#8681; {label}</a>'
    return f'<span class="dl off" title="run the pipeline to generate this">{label} — not generated yet</span>'


def render():
    trust_present = stage(TRUST)
    creds_present = stage_creds()

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
        </div>
        {dl_chip(href, 'Download', present)}
      </div>""")

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
          {dl_chip(href, 'Download .mpzpass', present)}
        </div>
      </article>""")

    built = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    html = PAGE.format(
        trust="".join(trust_rows), cards="".join(cards), built=built)
    with open(os.path.join(HERE, "index.html"), "w") as f:
        f.write(html)

    print("wrote index.html")
    print("trust staged:", sorted(trust_present) or "(none — build VICAL/RICAL)")
    print("creds staged:", sorted(creds_present) or "(none — mint first)")


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
  .dl {{ align-self:flex-start; margin-top:6px; background:linear-gradient(135deg,var(--accent),var(--accent2));
    color:#0a0e1c; font-weight:700; text-decoration:none; padding:9px 14px; border-radius:10px; font-size:14px; }}
  .dl.off {{ background:#232a44; color:var(--muted); font-weight:600; cursor:not-allowed; }}
  .trow .dl {{ white-space:nowrap; }}
  ol.steps {{ color:var(--muted); padding-left:20px; }}
  ol.steps li {{ margin:6px 0; }}
  ol.steps b {{ color:var(--ink); }}
  footer {{ margin-top:40px; color:var(--muted); font-size:13px; border-top:1px solid var(--line); padding-top:16px; }}
  @media (max-width:640px) {{ .grid {{ grid-template-columns:1fr; }} .trow {{ flex-direction:column; align-items:flex-start; }} }}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>CredentAgent — Demo Wallet Credentials</h1>
    <p class="lede">Load these into a Multipaz wallet on your phone to satisfy the
      CredentAgent consent gates cross-device. Import the trust lists first, then
      the credentials.</p>
  </header>

  <div class="banner">
    <b>Demo trust only.</b> These credentials are signed by a self-generated demo
    PKI (dev IACA / document signer), not a real issuer. The wire crypto is real;
    the <b>trust anchor is not</b>. Do not treat a passing gate as a real safety
    or payment control.
  </div>

  <h2>1 · Trust setup — import first</h2>
  <div class="trust">{trust}</div>

  <h2>2 · Credentials</h2>
  <div class="grid">{cards}</div>

  <h2>3 · How to import</h2>
  <ol class="steps">
    <li>On the phone, open this page in the browser and download the <b>VICAL</b>
      and <b>RICAL</b> from section 1.</li>
    <li>Import them into the Multipaz wallet's trust settings so the demo issuer
      and reader are trusted.</li>
    <li>Download each <b>.mpzpass</b> and open it with the Multipaz wallet to add
      the credential.</li>
    <li>Run a CredentAgent ceremony; the matching card should satisfy the gate
      with no red trust warning.</li>
  </ol>

  <footer>Built {built}. Part of Open Mobile Hub · demo PKI, presence-only trust level.</footer>
</div>
</body>
</html>
"""


if __name__ == "__main__":
    render()
