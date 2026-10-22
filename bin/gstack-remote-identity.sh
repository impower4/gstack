# shellcheck shell=bash
# gstack-remote-identity.sh — the one bash owner of git-remote project identity
# (twin of lib/remote-identity.ts; test/remote-identity-vectors.test.ts runs both
# against the golden vectors in test/fixtures/remote-identity-vectors.json, so
# the two can never disagree on a canonical remote or a slug). Sourced, never
# executed: bin/gstack-slug and browse/bin/remote-slug source it. bash 3.2 safe.
#
# Canonical remote (#3003): one spelling per repository, whichever way it was
# cloned. Hosted remotes (scheme://… or scp-like host:path) become
# "<host>/<seg>/<seg>…": host lowercased (ASCII, locale-independent), userinfo,
# credentials and port dropped, one trailing ".git" and stray slashes removed,
# then host-specific normalization BEFORE segments are counted:
#   - Azure DevOps: ssh "v3/" prefix and https "_git" dropped, ssh.dev.azure.com
#     and *.visualstudio.com folded to dev.azure.com/<org>/<project>/<repo>.
#   - Bitbucket Server: a leading "scm/" (https only spelling) dropped.
# Local remotes (absolute/relative paths, file://) keep their path as identity.
#
# Slug: a hosted remote with 3+ segments (GitLab nested groups, Azure DevOps)
# files under "<last-two>-<first 16 hex of sha256(canonical)>" so a/product/repo
# and b/product/repo stop sharing projects/product-repo/. Everything else (all
# 2-segment remotes, i.e. all of GitHub, and local paths) keeps the legacy
# last-two parse byte-for-byte, so no existing bucket moves.

# _gri_lower — ASCII lowercase, locale-independent.
_gri_lower() { printf '%s' "$1" | LC_ALL=C tr 'A-Z' 'a-z'; }

# gstack_sha256_16 <string> — first 16 hex chars of sha256, portable.
gstack_sha256_16() {
  _gri_digest=""
  if command -v sha256sum >/dev/null 2>&1; then
    _gri_digest=$(printf '%s' "$1" | sha256sum 2>/dev/null)
  elif command -v shasum >/dev/null 2>&1; then
    _gri_digest=$(printf '%s' "$1" | shasum -a 256 2>/dev/null)
  elif command -v openssl >/dev/null 2>&1; then
    _gri_digest=$(printf '%s' "$1" | openssl dgst -sha256 -r 2>/dev/null)
  fi
  _gri_digest=$(printf '%s' "$_gri_digest" | LC_ALL=C tr -cd '0-9a-f' | cut -c1-16)
  printf '%s' "$_gri_digest"
}

# gstack_legacy_remote_slug <url> — the pre-#3003 parse, kept byte-identical:
# strip ONE trailing ".git", keep the last two path segments as owner-repo
# (sed's no-match passthrough leaves the stripped URL itself), sanitize, and
# reject degenerate results ("", ".", "..").
gstack_legacy_remote_slug() {
  _gri_l=$(printf '%s' "${1%.git}" | sed -E 's#.*[:/]([^/]+)/([^/]+)$#\1-\2#' | tr -cd 'a-zA-Z0-9._-')
  case "$_gri_l" in ""|.|..) _gri_l="" ;; esac
  printf '%s' "$_gri_l"
}

# gstack_canonical_remote <url> — sets:
#   _gri_canon   canonical identity string ("" when the url is empty)
#   _gri_hosted  1 for host-bearing remotes, 0 for local paths
#   _gri_nseg    number of path segments after normalization (hosted only)
#   _gri_last2   "<second-to-last>-<last>" segment pair (hosted, nseg >= 2)
gstack_canonical_remote() {
  _gri_url=$(printf '%s' "$1" | tr -d '\r\n')
  _gri_canon=""; _gri_hosted=0; _gri_nseg=0; _gri_last2=""
  [ -n "$_gri_url" ] || return 0
  _gri_host=""; _gri_path=""; _gri_scheme=""
  if [[ "$_gri_url" =~ ^([A-Za-z][A-Za-z0-9+.-]*)://(.*)$ ]]; then
    _gri_scheme=$(_gri_lower "${BASH_REMATCH[1]}")
    _gri_rest="${BASH_REMATCH[2]}"
    if [ "$_gri_scheme" != "file" ]; then
      _gri_auth="${_gri_rest%%/*}"
      if [ "$_gri_auth" = "$_gri_rest" ]; then _gri_path=""; else _gri_path="${_gri_rest#*/}"; fi
      _gri_auth="${_gri_auth##*@}"
      if [[ "$_gri_auth" =~ ^(\[[^]]*\]) ]]; then
        _gri_host="${BASH_REMATCH[1]}"
      else
        _gri_host="${_gri_auth%%:*}"
      fi
      _gri_hosted=1
    else
      _gri_path="$_gri_rest"
    fi
  elif ! [[ "$_gri_url" =~ ^[A-Za-z]:([/\\]|$) ]] && [[ "$_gri_url" =~ ^([^/:]+):(.*)$ ]]; then
    _gri_host="${BASH_REMATCH[1]##*@}"
    _gri_path="${BASH_REMATCH[2]}"
    _gri_hosted=1
  else
    _gri_path="$_gri_url"
  fi

  if [ "$_gri_hosted" -eq 0 ]; then
    while [ "${#_gri_path}" -gt 1 ] && [ "${_gri_path%/}" != "$_gri_path" ]; do _gri_path="${_gri_path%/}"; done
    _gri_path="${_gri_path%.git}"
    while [ "${#_gri_path}" -gt 1 ] && [ "${_gri_path%/}" != "$_gri_path" ]; do _gri_path="${_gri_path%/}"; done
    _gri_canon="$_gri_path"
    return 0
  fi

  _gri_host=$(_gri_lower "$_gri_host")
  while [ "${_gri_path%/}" != "$_gri_path" ]; do _gri_path="${_gri_path%/}"; done
  _gri_path="${_gri_path%.git}"
  _gri_segs=()
  _gri_rem="$_gri_path"
  while [ -n "$_gri_rem" ]; do
    _gri_s="${_gri_rem%%/*}"
    if [ "$_gri_s" = "$_gri_rem" ]; then _gri_rem=""; else _gri_rem="${_gri_rem#*/}"; fi
    if [ -n "$_gri_s" ]; then _gri_segs[${#_gri_segs[@]}]="$_gri_s"; fi
  done

  case "$_gri_host" in
    ssh.dev.azure.com|vs-ssh.visualstudio.com)
      if [ "${#_gri_segs[@]}" -gt 0 ] && [ "${_gri_segs[0]}" = "v3" ]; then _gri_segs=("${_gri_segs[@]:1}"); fi
      _gri_host="dev.azure.com" ;;
    dev.azure.com) ;;
    *.visualstudio.com)
      if [ "${#_gri_segs[@]}" -gt 0 ] && [ "${_gri_segs[0]}" = "DefaultCollection" ]; then _gri_segs=("${_gri_segs[@]:1}"); fi
      _gri_segs=("${_gri_host%%.*}" ${_gri_segs[@]+"${_gri_segs[@]}"})
      _gri_host="dev.azure.com" ;;
    *)
      if [ "${#_gri_segs[@]}" -ge 3 ] && [ "${_gri_segs[0]}" = "scm" ]; then _gri_segs=("${_gri_segs[@]:1}"); fi ;;
  esac
  if [ "$_gri_host" = "dev.azure.com" ]; then
    _gri_kept=()
    for _gri_s in ${_gri_segs[@]+"${_gri_segs[@]}"}; do
      [ "$_gri_s" = "_git" ] || _gri_kept[${#_gri_kept[@]}]="$_gri_s"
    done
    _gri_segs=(${_gri_kept[@]+"${_gri_kept[@]}"})
  fi

  _gri_nseg=${#_gri_segs[@]}
  _gri_canon="$_gri_host"
  for _gri_s in ${_gri_segs[@]+"${_gri_segs[@]}"}; do _gri_canon="$_gri_canon/$_gri_s"; done
  if [ "$_gri_nseg" -ge 2 ]; then
    _gri_last2="${_gri_segs[$((_gri_nseg - 2))]}-${_gri_segs[$((_gri_nseg - 1))]}"
  fi
  return 0
}

# gstack_remote_slug <url> — sets _gri_slug (the project slug for this remote,
# "" when degenerate) and _gri_legacy_slug (the pre-#3003 slug). The two differ
# only for hosted remotes with 3+ segments.
gstack_remote_slug() {
  gstack_canonical_remote "$1"
  _gri_legacy_slug=$(gstack_legacy_remote_slug "$1")
  _gri_slug="$_gri_legacy_slug"
  if [ "$_gri_hosted" -eq 1 ] && [ "$_gri_nseg" -ge 3 ]; then
    _gri_hash=$(gstack_sha256_16 "$_gri_canon")
    if [ "${#_gri_hash}" -eq 16 ]; then
      _gri_slug=$(printf '%s-%s' "$_gri_last2" "$_gri_hash" | tr -cd 'a-zA-Z0-9._-')
    fi
  fi
  return 0
}
