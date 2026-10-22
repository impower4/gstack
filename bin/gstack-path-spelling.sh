# shellcheck shell=bash
# gstack-path-spelling.sh — sourced helper: one spelling for paths on Windows
# shells. Git Bash (MSYS) spells a drive path /c/x, native programs (git.exe,
# bun.exe) answer C:/x or C:\x, and MSYS converts /c/x arguments to C:/x before
# a native program starts. Comparing two spellings as strings is the bug class
# behind #3088, #3100 and #3101. TS twin: lib/path-spelling.ts.
#
#   gstack_path_shell PATH    Git Bash's drive spelling (/c/x) of an absolute
#                             PATH, mount aliases such as /tmp resolved through
#                             their drive path; unchanged outside Windows shells
#   gstack_path_native PATH   the native spelling (C:/x) on Windows shells;
#                             unchanged elsewhere
#   gstack_path_same A B      true when A and B name the same file: filesystem
#                             identity when both exist, else equal shell
#                             spellings
#   gstack_path_absolute PATH true when PATH is absolute in any spelling (/x,
#                             C:/x, C:\x): Git for Windows answers C:/x
#   gstack_path_within PATH DIR
#                             true when the existing DIR is PATH or one of its
#                             ancestors, by gstack_path_same on each ancestor
#                             of the absolute PATH
#
# No side effects beyond the _GSTACK_PS_* variables; safe under set -u.

case "$(uname -s 2>/dev/null)" in
  MINGW*|MSYS*) _GSTACK_PS_KIND=msys ;;
  CYGWIN*) _GSTACK_PS_KIND=cygwin ;;
  *) _GSTACK_PS_KIND=posix ;;
esac

gstack_path_shell() {
  case "$_GSTACK_PS_KIND" in
    posix) printf '%s\n' "$1"; return 0 ;;
    cygwin) cygpath -u "$1" 2>/dev/null || printf '%s\n' "$1"; return 0 ;;
  esac
  _gps_p=$(cygpath -am "$1" 2>/dev/null) || _gps_p=""
  [ -n "$_gps_p" ] || _gps_p=$1
  _gps_p=$(printf '%s' "$_gps_p" | tr '\\' '/')
  case "$_gps_p" in
    [A-Za-z]:|[A-Za-z]:/*)
      _gps_d=$(printf '%s' "${_gps_p%%:*}" | tr '[:upper:]' '[:lower:]')
      _gps_p="/$_gps_d${_gps_p#?:}" ;;
  esac
  printf '%s\n' "$_gps_p"
}

gstack_path_native() {
  case "$_GSTACK_PS_KIND" in
    posix) printf '%s\n' "$1"; return 0 ;;
  esac
  _gpn_p=$(cygpath -am "$1" 2>/dev/null) || _gpn_p=""
  if [ -z "$_gpn_p" ]; then
    _gpn_p=$(printf '%s' "$1" | tr '\\' '/')
    case "$_gpn_p" in
      /[A-Za-z]|/[A-Za-z]/*)
        _gpn_d=$(printf '%s' "${_gpn_p:1:1}" | tr '[:lower:]' '[:upper:]')
        _gpn_p="$_gpn_d:${_gpn_p:2}"
        [ -n "${_gpn_p#?:}" ] || _gpn_p="$_gpn_p/" ;;
    esac
  fi
  printf '%s\n' "$_gpn_p"
}

gstack_path_same() {
  if { [ -e "$1" ] || [ -L "$1" ]; } && { [ -e "$2" ] || [ -L "$2" ]; }; then
    [ "$1" -ef "$2" ]
    return
  fi
  [ "$(gstack_path_shell "$1")" = "$(gstack_path_shell "$2")" ]
}

gstack_path_absolute() {
  case "$1" in /*|[A-Za-z]:[\\/]*) return 0 ;; esac
  return 1
}

gstack_path_within() {
  [ -e "$2" ] || return 1
  _gpw_p=$1
  while [ -n "$_gpw_p" ]; do
    gstack_path_same "$_gpw_p" "$2" && return 0
    case "$_gpw_p" in /|[A-Za-z]:|[A-Za-z]:/) return 1 ;; esac
    _gpw_p=${_gpw_p%/}
    case "$_gpw_p" in */*) _gpw_p=${_gpw_p%/*}; [ -n "$_gpw_p" ] || _gpw_p=/ ;; *) return 1 ;; esac
  done
  return 1
}
