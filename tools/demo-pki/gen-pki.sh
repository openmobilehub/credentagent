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
# Requires OpenSSL 3.x (the ISO EKU OID + issuerAltName URI syntax need it;
# macOS LibreSSL is too old). Override the binary and demo host with env vars:
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

# Explicit notBefore/notAfter (UTC, [CC]YYMMDDHHMMSSZ). macOS `date -v` syntax.
NB="$(date -u -v-${BACKDATE_DAYS}d +%Y%m%d%H%M%SZ)"
CA_NA="$(date -u -v+${CA_DAYS}d +%Y%m%d%H%M%SZ)"
DS_NA="$(date -u -v+${DS_DAYS}d +%Y%m%d%H%M%SZ)"

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
