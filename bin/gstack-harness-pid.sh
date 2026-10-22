# shellcheck shell=bash
# gstack-harness-pid.sh — the harness pid behind a gstack command (sourced,
# never executed). One derivation for every writer that keys per-session
# state on it: bin/gstack-skill-start (the state-root session marker) and
# bin/gstack-lease (the install-scoped workflow lease), so an updater that
# reads leases sees the same pid the session wrote. Bash 3.2 plus ps.
#
# gstack_harness_pid START — walk up from START (the calling shell) past
# shell wrappers and print the first non-shell ancestor. Claude Code runs a
# tool call under a per-call `bash -c`, whose parent is the harness; a host
# that execs the command directly is already the parent. Without a usable ps
# (some Windows shells) START stands. At most 8 hops; pid 0 and 1 stop.
gstack_harness_pid() {
  _hp_pid="$1"
  _hp_hops=0
  while [ "$_hp_hops" -lt 8 ]; do
    _hp_comm=$(ps -o comm= -p "$_hp_pid" 2>/dev/null | head -1) || break
    _hp_comm=${_hp_comm##*/}; _hp_comm=${_hp_comm#-}
    case "$_hp_comm" in bash|sh|zsh|dash|ksh|mksh|ash|fish|busybox) ;; *) break ;; esac
    _hp_up=$(ps -o ppid= -p "$_hp_pid" 2>/dev/null | tr -d ' ')
    case "$_hp_up" in ''|*[!0-9]*|0|1) break ;; esac
    _hp_pid="$_hp_up"
    _hp_hops=$((_hp_hops + 1))
  done
  printf '%s\n' "$_hp_pid"
}
