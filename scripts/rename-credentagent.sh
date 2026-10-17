#!/usr/bin/env bash
# Rename AttestoMCP → CredentAgent (issue #37).
#
# Repeatable, case-aware, exemption-respecting. Run from a repo root:
#   ./scripts/rename-credentagent.sh
# Reused by PR #31 (retrofit) and attestomcp-website.
#
# Order matters: longest/most-specific tokens first so substrings never
# double-replace. Standalone "Attesto"/"attesto" are NOT replaced here —
# they need case-by-case review (historical prose vs. live brand).
set -euo pipefail

# Files that record naming HISTORY — never rewrite (the PR #8 lesson).
EXEMPT=(
  "docs/naming-clearance.md"
  "docs/naming-counsel-brief.md"
  "scripts/rename-credentagent.sh"
)
is_exempt() {
  local f="$1"
  for e in "${EXEMPT[@]}"; do [[ "$f" == *"$e" ]] && return 0; done
  # Dated research records keep their historical names.
  [[ "$f" == *"docs/superpowers/research/"* ]] && return 0
  # In a git WORKTREE, .git is a pointer FILE containing a path — never touch it.
  [[ "$(basename "$f")" == ".git" ]] && return 0
  return 1
}

FILES=$(grep -rlE 'AttestoMCP|attestoMCP|attestomcp|ATTESTOMCP' . \
  --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist \
  --exclude-dir=.next --exclude-dir=build 2>/dev/null || true)

count=0
for f in $FILES; do
  if is_exempt "$f"; then echo "SKIP (exempt): $f"; continue; fi
  perl -pi -e '
    s/AttestoMCP/CredentAgent/g;   # brand, class, options type
    s/attestoMCP/credentAgent/g;   # camelCase (attestoMCPManifest)
    s/ATTESTOMCP/CREDENTAGENT/g;   # shouting constants, if any
    s/attestomcp/credentagent/g;   # packages, routes, paths, urls
  ' "$f"
  count=$((count+1))
done
echo "Rewrote $count files."

echo
echo "Remaining standalone attesto/Attesto (review case-by-case):"
grep -rniE '\battestos?\b' . \
  --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist \
  --exclude-dir=.next --exclude-dir=build 2>/dev/null \
  | grep -vE 'naming-clearance|naming-counsel-brief|docs/superpowers/research' || echo "  none"
