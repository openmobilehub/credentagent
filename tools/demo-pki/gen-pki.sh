#!/usr/bin/env bash
#
# gen-pki.sh — reproducibly generate the CredentAgent demo ISO 18013-5 PKI.
#
# Produces, all P-256 / ecdsa-with-SHA256:
#   IACA root (self-signed CA)          -> certs/iaca-cert.pem   keys/iaca-key.pem
#   Document Signer (issued by IACA)    -> certs/ds-cert.pem     keys/ds-key.pem
#   Reader root (self-signed CA)        -> certs/reader-root-cert.pem  keys/reader-root-key.pem
#   Reader leaf (issued by reader root) -> certs/reader-cert.pem  keys/reader-key.pem
#   Trust-list signer (self-signed)     -> certs/list-signer-cert.pem  keys/list-signer-key.pem
#   DS chain (ds + iaca)                -> certs/ds-chain.pem
#
# Private keys land in keys/ (gitignored, chmod 700). Public certs land in
# certs/ (committed). Re-running regenerates a fresh, valid PKI (new random keys
# — "reproducible" means a correct PKI every time, not bit-identical output).
#
# Extension profiles live in openssl.cnf and mirror Multipaz's MdocUtil. See that
# file and MORNING-BRIEF.md for the ISO Annex-B references and the choices made.
#
# Requires OpenSSL 3.2+ (the `-not_before`/`-not_after` flags on req/x509 landed in
# 3.2; the ISO EKU OID + issuerAltName URI syntax need OpenSSL, not LibreSSL). The
# script checks the version and auto-detects BSD/macOS vs GNU/Linux `date`, so it
# runs on both. Override the binary and demo host with env vars:
#   OPENSSL=/opt/homebrew/opt/openssl@3/bin/openssl  BASE_URL=https://your-host  ./gen-pki.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

OPENSSL="${OPENSSL:-/opt/homebrew/opt/openssl@3/bin/openssl}"
BASE_URL="${BASE_URL:-https://credentagent-demo.example}"
# READER_DNS is a LIST of hostnames baked into the reader cert's SubjectAltName —
# the reader is trusted when the gate is served from ANY of them. Space- or
# comma-separated. `localhost` covers local testing (gate at localhost:3007 via
# `adb reverse`); add your hosted gate's STABLE host to avoid a later re-mint.
# Changing this regenerates the reader cert → you must rebuild the RICAL and
# re-import it on the phone (see README.md "Wire the verifier").
READER_DNS="${READER_DNS:-localhost credentagent-demo.example}"

# URIs referenced by openssl.cnf via ${ENV::...}. IssuerAltName + CRL endpoints.
# They need not resolve for a demo; they must merely be present & well-formed.
export IACA_IAN_URI="${BASE_URL}/pki/iaca"
export IACA_CRL_URI="${BASE_URL}/pki/iaca.crl"
export READER_CRL_URI="${BASE_URL}/pki/reader-root.crl"

# Build the OpenSSL SAN value ("DNS:a, DNS:b") from the READER_DNS list, so the
# reader leaf can name multiple origins. openssl.cnf's [v3_reader] reads $READER_SAN.
READER_SAN=""
for _h in ${READER_DNS//,/ }; do
  [ -n "$_h" ] || continue
  READER_SAN="${READER_SAN:+$READER_SAN, }DNS:${_h}"
done
export READER_DNS READER_SAN

CURVE="P-256"
CA_DAYS=3650   # 10y for the self-signed roots (IACA / reader root / list signer)
DS_DAYS=455    # ISO 18013-5 Table B.3 caps the DS validity at 457 days; stay under it
BACKDATE_DAYS=2  # notBefore backdated so an MSO "signed" ~now-1d stays inside DS validity
SUBJ_BASE="/C=US/ST=CA/O=Utopia (Demo)"

# Fail fast if the toolchain can't produce a valid PKI: `-not_before`/`-not_after`
# on req/x509 landed in OpenSSL 3.2, and LibreSSL lacks the ISO EKU OID + URI syntax.
_ver_line="$("$OPENSSL" version 2>/dev/null)"
case "$_ver_line" in
  LibreSSL*) echo "ERROR: $OPENSSL is LibreSSL ($_ver_line) — need OpenSSL 3.2+ (LibreSSL lacks the ISO EKU OID and -not_before/-not_after)." >&2; exit 1 ;;
esac
_ver="$(printf '%s\n' "$_ver_line" | awk '{print $2}')"; _maj="${_ver%%.*}"; _rest="${_ver#*.}"; _min="${_rest%%.*}"
if [ "${_maj:-0}" -lt 3 ] || { [ "$_maj" = 3 ] && [ "${_min:-0}" -lt 2 ]; }; then
  echo "ERROR: gen-pki.sh needs OpenSSL 3.2+ (for -not_before/-not_after on req/x509); found '${_ver:-unknown}' from $OPENSSL." >&2
  echo "  macOS: brew install openssl@3 && OPENSSL=\"\$(brew --prefix openssl@3)/bin/openssl\" ./gen-pki.sh" >&2
  exit 1
fi

# Explicit notBefore/notAfter (UTC, [CC]YYMMDDHHMMSSZ). Portable across BSD/macOS
# (`date -v`) and GNU/Linux (`date -d`).
if date -u -v+1d +%Y >/dev/null 2>&1; then _date_bsd=1; else _date_bsd=0; fi
date_offset() {  # $1 = signed days, e.g. "-2" or "+455"
  if [ "$_date_bsd" = 1 ]; then date -u -v"${1}d" +%Y%m%d%H%M%SZ
  else date -u -d "${1} days" +%Y%m%d%H%M%SZ; fi
}
NB="$(date_offset "-${BACKDATE_DAYS}")"
CA_NA="$(date_offset "+${CA_DAYS}")"
DS_NA="$(date_offset "+${DS_DAYS}")"

mkdir -p keys certs
chmod 700 keys

rand_serial() { echo "0x$("$OPENSSL" rand -hex 16)"; }
genkey() { "$OPENSSL" genpkey -algorithm EC -pkeyopt "ec_paramgen_curve:${CURVE}" -out "$1"; }

echo ">> OpenSSL: $("$OPENSSL" version)"
echo ">> BASE_URL=$BASE_URL  reader SAN=[$READER_SAN]"

# ---- 1. IACA root (self-signed) ----
genkey keys/iaca-key.pem
"$OPENSSL" req -new -x509 -key keys/iaca-key.pem -sha256 -not_before "$NB" -not_after "$CA_NA" \
  -config openssl.cnf -extensions v3_iaca \
  -subj "${SUBJ_BASE}/CN=Utopia Demo IACA" \
  -out certs/iaca-cert.pem
echo ">> IACA root        -> certs/iaca-cert.pem"

# ---- 2. Document Signer (issued by IACA) ----
genkey keys/ds-key.pem
"$OPENSSL" req -new -key keys/ds-key.pem \
  -subj "${SUBJ_BASE}/CN=Utopia Demo Document Signer" -out keys/ds.csr
"$OPENSSL" x509 -req -in keys/ds.csr -sha256 -not_before "$NB" -not_after "$DS_NA" \
  -CA certs/iaca-cert.pem -CAkey keys/iaca-key.pem -set_serial "$(rand_serial)" \
  -extfile openssl.cnf -extensions v3_ds \
  -out certs/ds-cert.pem
rm -f keys/ds.csr
echo ">> Document Signer  -> certs/ds-cert.pem (${DS_DAYS}d)"

# ---- 3. Reader root (self-signed) ----
genkey keys/reader-root-key.pem
"$OPENSSL" req -new -x509 -key keys/reader-root-key.pem -sha256 -not_before "$NB" -not_after "$CA_NA" \
  -config openssl.cnf -extensions v3_reader_root \
  -subj "${SUBJ_BASE}/CN=Utopia Demo Reader Root" \
  -out certs/reader-root-cert.pem
echo ">> Reader root      -> certs/reader-root-cert.pem"

# ---- 4. Reader leaf (issued by reader root) ----
genkey keys/reader-key.pem
"$OPENSSL" req -new -key keys/reader-key.pem \
  -subj "${SUBJ_BASE}/CN=Utopia Demo Reader" -out keys/reader.csr
"$OPENSSL" x509 -req -in keys/reader.csr -sha256 -not_before "$NB" -not_after "$DS_NA" \
  -CA certs/reader-root-cert.pem -CAkey keys/reader-root-key.pem -set_serial "$(rand_serial)" \
  -extfile openssl.cnf -extensions v3_reader \
  -out certs/reader-cert.pem
rm -f keys/reader.csr
echo ">> Reader leaf      -> certs/reader-cert.pem (${DS_DAYS}d)"

# ---- 5. Trust-list signer (self-signed) ----
genkey keys/list-signer-key.pem
"$OPENSSL" req -new -x509 -key keys/list-signer-key.pem -sha256 -not_before "$NB" -not_after "$CA_NA" \
  -config openssl.cnf -extensions v3_list_signer \
  -subj "${SUBJ_BASE}/CN=Utopia Demo Trust List Signer" \
  -out certs/list-signer-cert.pem
echo ">> List signer      -> certs/list-signer-cert.pem"

# ---- 6. DS chain (leaf first) for the mdoc x5chain ----
cat certs/ds-cert.pem certs/iaca-cert.pem > certs/ds-chain.pem
echo ">> DS chain         -> certs/ds-chain.pem"

# ---- verify the two issued chains cryptographically ----
echo
echo ">> Verifying chains (purpose 'any' — the ISO EKU OID is not a TLS purpose):"
"$OPENSSL" verify -CAfile certs/iaca-cert.pem -purpose any certs/ds-cert.pem || true
"$OPENSSL" verify -CAfile certs/reader-root-cert.pem -purpose any certs/reader-cert.pem || true

echo
echo ">> Done. Public certs in certs/ ; private keys in keys/ (gitignored)."
