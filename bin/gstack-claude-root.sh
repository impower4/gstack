# shellcheck shell=bash
# gstack-claude-root.sh — sourced helper: the stable install root that Claude
# hook commands are registered at (setup's canonical-only rule). Used by setup
# and bin/gstack-memorable so both write the same path into settings.json.
#
#   gstack_canonical_claude_root   prints ${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills/gstack,
#                                  or $HOME/.claude/skills/gstack when that
#                                  install exists and the config-dir root is
#                                  missing (the installer writes to $HOME) or
#                                  resolves to the same tree (a per-session
#                                  CLAUDE_CONFIG_DIR whose skills link back to
#                                  $HOME, #3180: only the $HOME spelling
#                                  outlives the session)
#
# Neither answer is the running tree, so canonical-only still holds. No side
# effects; safe under set -u.

gstack_canonical_claude_root() {
  local root="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills/gstack"
  local home_root="$HOME/.claude/skills/gstack"
  if [ -x "$home_root/bin/gstack-session-update" ]; then
    if [ ! -x "$root/bin/gstack-session-update" ] \
       || [ "$(CDPATH= cd -- "$root" && pwd -P)" = "$(CDPATH= cd -- "$home_root" && pwd -P)" ]; then
      root="$home_root"
    fi
  fi
  printf '%s\n' "$root"
}
