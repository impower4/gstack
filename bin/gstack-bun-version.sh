# shellcheck shell=bash
# gstack-bun-version.sh — the one source for the Bun versions gstack needs.
# Sourced, never executed: ./setup refuses or warns from it before writing
# anything, and bin/gstack-session-update and /gstack-upgrade read the
# INCOMING release's floor (gstack_bun_incoming_hold) before advancing a
# live checkout. test/bun-version-drift.test.ts
# keeps it equal to package.json engines.bun, every CI pin, setup's install
# hint and README. Bash 3.2 builtins only.
#
# GSTACK_BUN_FLOOR is the security floor. Older Bun accepts
# --no-compile-autoload-dotenv/--no-compile-autoload-bunfig but ignores them,
# so gstack's compiled tools would read a project's .env. Verified by a
# compiled probe (a binary built with all four no-autoload flags, run beside a
# .env): Bun 1.3.2 loads it, 1.3.3 and 1.4.0 do not.
# GSTACK_BUN_TESTED is the supported minimum: the CI pin and engines.bun.
# GSTACK_BUN_DEFAULT is what the Capy installer downloads when no project pin
# decides (GSTACK_BUN_INSTALL_VERSION overrides it); it is a verified archive
# at or above the minimum, and one CI job runs the quick tier on it.
GSTACK_BUN_FLOOR="1.3.3"
GSTACK_BUN_TESTED="1.4.2"
GSTACK_BUN_DEFAULT="1.4.3"

# gstack_bun_archive_sha256 TARGET [VERSION] — the SHA-256 of
# https://github.com/oven-sh/bun/releases/download/bun-v$VERSION/bun-TARGET.zip
# (VERSION defaults to $GSTACK_BUN_TESTED) from that release's SHASUMS256.txt,
# for the targets bin/gstack-capy-install installs on Capy cloud machines (the
# same exact-archive recipe as .github/docker/Dockerfile.ci;
# test/bun-version-drift.test.ts keeps the $GSTACK_BUN_TESTED rows equal). A
# newer version is listed so the installer can follow a project's exact pin
# above the minimum. Prints nothing and returns 1 without a verified archive.
GSTACK_BUN_VERIFIED="1.4.2 1.4.3"
gstack_bun_archive_sha256() {
  case "${2:-$GSTACK_BUN_TESTED}" in
    1.4.2) case "$1" in
      linux-x64) echo 36368faef7527875d5ffa52e53cd48021741f2a83eb6208a8dd64068d422a913 ;;
      linux-x64-baseline) echo c678040f14fe0440eb839d37cbd0ce4c051a32da72806ac97de6a6aab6bf728f ;;
      linux-aarch64) echo 54328bbc2d9c8e0c9f892c544d66c57a83b84139e34909e5ee81758f1ac8fda7 ;;
      *) return 1 ;;
    esac ;;
    1.4.3) case "$1" in
      linux-x64) echo 3e730528d89775f03f87f05c06787c4df4099d0a37f3f252e7b829cb23816e18 ;;
      linux-x64-baseline) echo 1fc2edac843102909e3a1be1d8d9802cc6071cf074e67e88231f4ffe0f8b397b ;;
      linux-aarch64) echo efa9813da5ed72423bf847f916e8d2c47c0d776add972354026a75e10da9aa21 ;;
      *) return 1 ;;
    esac ;;
    *) return 1 ;;
  esac
}

# _gstack_bun_parse <version> — sets _gb_core ("MAJOR MINOR PATCH" as decimal
# integers) and _gb_pre (prerelease, may be empty); returns 1 when malformed.
# A leading "v" and "+build" metadata are ignored.
_gstack_bun_parse() {
  _gb_v="${1#v}"; _gb_v="${_gb_v%%+*}"; _gb_pre=""
  case "$_gb_v" in
    *-*) _gb_pre="${_gb_v#*-}"; _gb_v="${_gb_v%%-*}"; [ -n "$_gb_pre" ] || return 1 ;;
  esac
  case "$_gb_v" in *.*.*) ;; *) return 1 ;; esac
  _gb_maj="${_gb_v%%.*}"; _gb_rest="${_gb_v#*.}"; _gb_min="${_gb_rest%%.*}"; _gb_pat="${_gb_rest#*.}"
  case "$_gb_maj" in ''|*[!0-9]*) return 1 ;; esac
  case "$_gb_min" in ''|*[!0-9]*) return 1 ;; esac
  case "$_gb_pat" in ''|*[!0-9]*) return 1 ;; esac
  case "$_gb_pre" in *[!0-9A-Za-z.-]*) return 1 ;; esac
  _gb_core="$((10#$_gb_maj)) $((10#$_gb_min)) $((10#$_gb_pat))"
}

# _gstack_bun_below <version> <release> — returns 0 when version sorts below
# the release, 1 when it does not, and 2 when either cannot be parsed (callers
# never read 2 as "not below"). Prerelease rule (semver): 1.3.3-canary.1 is
# below 1.3.3 and above 1.3.2, so a prerelease of the floor itself is refused.
# The release's fields are copied into quoted positional parameters before the
# second parse, so the comparison does not depend on word splitting (zsh does
# not split; #3195).
_gstack_bun_below() {
  _gstack_bun_parse "$2" || return 2
  set -- "$1" "$_gb_maj" "$_gb_min" "$_gb_pat"
  _gstack_bun_parse "$1" || return 2
  [ "$((10#$_gb_maj))" -ne "$((10#$2))" ] && { [ "$((10#$_gb_maj))" -lt "$((10#$2))" ]; return; }
  [ "$((10#$_gb_min))" -ne "$((10#$3))" ] && { [ "$((10#$_gb_min))" -lt "$((10#$3))" ]; return; }
  [ "$((10#$_gb_pat))" -ne "$((10#$4))" ] && { [ "$((10#$_gb_pat))" -lt "$((10#$4))" ]; return; }
  [ -n "$_gb_pre" ]
}

# gstack_bun_status <version> [floor] — prints too-old, untested, ok or
# malformed (the version or the floor cannot be parsed). The optional floor
# lets the auto-updater apply the incoming release's floor with this
# release's comparison rule.
gstack_bun_status() {
  _gstack_bun_below "$1" "${2:-$GSTACK_BUN_FLOOR}"
  case $? in
    0) echo too-old ;;
    1) _gstack_bun_below "$1" "$GSTACK_BUN_TESTED"
       case $? in 0) echo untested ;; 1) echo ok ;; *) echo malformed ;; esac ;;
    *) echo malformed ;;
  esac
}

# gstack_bun_incoming_hold <git-dir> <rev> — the pre-advance check shared by
# the auto-updater and /gstack-upgrade. Reads the floor from <rev>'s copy of
# this file and checks the `bun` setup will run (first on PATH). Below that
# floor it prints the held reason and returns 0. A version it cannot compare
# also holds (bun-version-unreadable, BUN_VERSION_UNREADABLE), with the bun
# path and its output passed through gstack_sanitize_echo
# (bin/gstack-sanitize-echo.sh in <git-dir>). Otherwise it prints nothing and
# returns 1 (no bun, or no floor in <rev>). The comparison rule is this release's.
gstack_bun_incoming_hold() {
  command -v bun >/dev/null 2>&1 || return 1
  _gb_floor=$(git -C "$1" show "$2:bin/gstack-bun-version.sh" 2>/dev/null | sed -n 's/^GSTACK_BUN_FLOOR="\([0-9A-Za-z.+-]*\)".*/\1/p' | head -1)
  [ -n "$_gb_floor" ] || return 1
  _gb_found=$(bun --version 2>/dev/null | head -1)
  case "$(gstack_bun_status "$_gb_found" "$_gb_floor")" in
    too-old) ;;
    malformed)
      echo "bun-version-unreadable: could not read the version of Bun at $( (. "$1/bin/gstack-sanitize-echo.sh" && gstack_sanitize_echo "$(command -v bun)") 2>/dev/null) (bun --version printed '$( (. "$1/bin/gstack-sanitize-echo.sh" && gstack_sanitize_echo "$_gb_found") 2>/dev/null)'); gstack $(git -C "$1" show "$2:VERSION" 2>/dev/null | head -1 | tr -cd '0-9A-Za-z.+-') needs $_gb_floor or newer (BUN_VERSION_UNREADABLE)"
      return 0 ;;
    *) return 1 ;;
  esac
  _gb_ver=$(git -C "$1" show "$2:VERSION" 2>/dev/null | head -1)
  echo "bun-too-old: found Bun $_gb_found at $(command -v bun); gstack ${_gb_ver:-update} needs $_gb_floor or newer"
}

# gstack_bun_install_version — the Bun the installer downloads when no exact
# project pin decides: GSTACK_BUN_INSTALL_VERSION when set, else
# GSTACK_BUN_DEFAULT. Prints the version; returns 1 when it has no verified
# archive or sits below the supported minimum (the caller refuses it).
gstack_bun_install_version() {
  _gb_iv="${GSTACK_BUN_INSTALL_VERSION:-$GSTACK_BUN_DEFAULT}"
  printf '%s\n' "$_gb_iv"
  case " $GSTACK_BUN_VERIFIED " in *" $_gb_iv "*) ;; *) return 1 ;; esac
  [ "$(gstack_bun_status "$_gb_iv")" = ok ]
}

# gstack_bun_store STATE_ROOT — the versioned runtime store: verified archives
# unpack to <store>/<version>/bun and are never replaced in place;
# ~/.bun/bin and $BUN_INSTALL/bin are never written.
gstack_bun_store() { printf '%s/runtimes/bun\n' "$1"; }

# GSTACK_BUN_SHIM_MARKER — the second line of the per-directory `bun` and
# `bunx` shims gstack-capy-install writes to ~/.local/bin. A file carrying it
# is never a resolution candidate and is the only kind of file gstack replaces.
GSTACK_BUN_SHIM_MARKER="# gstack-bun-shim: gstack-owned; delete this file to remove it"
_gstack_bun_is_shim() { [ -f "$1" ] && head -c 512 "$1" 2>/dev/null | grep -aqF "$GSTACK_BUN_SHIM_MARKER"; }

# gstack_realpath FILE — FILE with every symlink resolved (Bash 3.2: a
# readlink loop and cd -P, no realpath(1)). Returns 1 when unresolvable.
gstack_realpath() {
  _gb_rp="$1" _gb_n=0
  while [ -L "$_gb_rp" ]; do
    [ "$_gb_n" -lt 40 ] || return 1
    _gb_lk=$(readlink "$_gb_rp") || return 1
    case "$_gb_lk" in /*) _gb_rp="$_gb_lk" ;; *) _gb_rp="$(dirname "$_gb_rp")/$_gb_lk" ;; esac
    _gb_n=$((_gb_n + 1))
  done
  _gb_rd=$(cd -P "$(dirname "$_gb_rp")" 2>/dev/null && pwd -P) || return 1
  printf '%s/%s\n' "${_gb_rd%/}" "$(basename "$_gb_rp")"
}

_gstack_bun_try() { # RULE FILE ACCEPT
  [ -n "$2" ] && [ -f "$2" ] && [ -x "$2" ] || return 1
  _gstack_bun_is_shim "$2" && return 1
  _gb_rp=$(gstack_realpath "$2") || return 1
  case "$_gb_seen" in *"|$_gb_rp|"*) return 1 ;; esac
  _gb_seen="$_gb_seen$_gb_rp|"
  _gb_v=$("$_gb_rp" --version </dev/null 2>/dev/null | head -1 | tr -cd 'A-Za-z0-9.+-')
  if [ "$(gstack_bun_status "${_gb_v:-0}")" != ok ] || { [ -n "$3" ] && ! "$3" "$_gb_v" "$_gb_rp"; }; then
    _gb_judged="${_gb_judged:+$_gb_judged, }bun ${_gb_v:-unknown} at $_gb_rp ($1)"
    return 1
  fi
  _gb_bin="$_gb_rp" _gb_ver="$_gb_v" _gb_rule="$1"
}

# gstack_bun_resolve STORE [EXACT_PIN] [ACCEPT] — the one Bun resolution
# contract, shared by gstack-capy-install (install and --check), the doctor,
# the bun shim and install admission; resolveBun in lib/pregate/runtime.ts is
# the TypeScript twin and test/bun-resolve.test.ts runs both on one layout.
# Candidates, first eligible wins:
#   pin          STORE/<EXACT_PIN>/bun (the project's exact pin)
#   default      STORE/<gstack_bun_install_version>/bun
#   BUN_INSTALL  $BUN_INSTALL/bin/bun
#   home         $HOME/.bun/bin/bun
#   PATH         every bun on PATH, in order
# Eligible: it runs, reports a version at or above the supported minimum, and
# `ACCEPT <version> <realpath>` (the caller's project-pin check) succeeds. A
# shim-marked file is never a candidate; a realpath is judged once. Sets
# _gb_bin (realpath), _gb_ver, _gb_rule and _gb_judged (the candidates that ran
# and were refused, for messages); returns 1 with _gb_bin empty when none qualifies.
gstack_bun_resolve() {
  _gb_bin="" _gb_ver="" _gb_rule="" _gb_judged="" _gb_seen="|"
  _gb_store="$1" _gb_accept="${3:-}"
  [ -n "${2:-}" ] && _gstack_bun_try pin "$_gb_store/$2/bun" "$_gb_accept" && return 0
  _gb_dv=$(gstack_bun_install_version) && _gstack_bun_try default "$_gb_store/$_gb_dv/bun" "$_gb_accept" && return 0
  [ -n "${BUN_INSTALL:-}" ] && _gstack_bun_try BUN_INSTALL "$BUN_INSTALL/bin/bun" "$_gb_accept" && return 0
  [ -n "${HOME:-}" ] && _gstack_bun_try home "$HOME/.bun/bin/bun" "$_gb_accept" && return 0
  _gb_path="${PATH:-}:"
  while [ -n "$_gb_path" ]; do
    _gb_dir="${_gb_path%%:*}" _gb_path="${_gb_path#*:}"
    [ -n "$_gb_dir" ] && _gstack_bun_try PATH "$_gb_dir/bun" "$_gb_accept" && return 0
  done
  _gb_bin="" _gb_ver="" _gb_rule=""
  return 1
}

# gstack_bun_rule_text RULE — why a resolution was chosen, for summaries.
gstack_bun_rule_text() {
  case "$1" in
    pin) echo "the project's exact pin, from gstack's runtime store" ;;
    default) echo "gstack's install default, from gstack's runtime store" ;;
    BUN_INSTALL) echo "\$BUN_INSTALL/bin" ;;
    home) echo "~/.bun/bin" ;;
    PATH) echo "the first eligible bun on PATH" ;;
    *) echo "$1" ;;
  esac
}
