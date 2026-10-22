# shellcheck shell=bash
# gstack-node-runtime.sh — the project's pinned Node, Bash side (sourced by
# bin/gstack-capy-install, never executed). Bash 3.2 plus POSIX tools; needs
# gstack-bun-version.sh sourced first (gstack_realpath).
#
# A project's exact Node pins come from lib/runtime-pins.ts (PIN_EXACT_REQUIRED
# and PIN_CI_ALTERNATIVES lines for node): non-CI exact pins are required, CI
# exact pins in different jobs are alternatives, the same rule as Bun.
# Resolution order, the first that satisfies the pins winning:
#   1. the node first on PATH (rule PATH: nothing to launch);
#   2. per wanted version, gstack's runtime store <state root>/runtimes/node/<v>/bin/node
#      (rule store), then nvm's ${NVM_DIR:-~/.nvm}/versions/node/v<v>/bin/node (rule nvm);
#   3. every other node on PATH (rule PATH).
# Install downloads node-v<v>-<target>.tar.gz and SHASUMS256.txt from
# ${GSTACK_NODE_DIST_URL:-https://nodejs.org/dist}/v<v>/, checks the archive's
# SHA-256 against that list (nvm's own check) and publishes the tree in the
# store by rename. /usr/local/bin and nvm are never written.

gstack_node_store() { printf '%s/runtimes/node\n' "$1"; }

# gstack_node_version FILE — the version FILE reports, without the leading v.
gstack_node_version() {
  local v
  [ -x "$1" ] || return 1
  v=$("$1" --version </dev/null 2>/dev/null | head -1 | tr -cd 'v0-9.')
  v="${v#v}"
  [ -n "$v" ] && printf '%s\n' "$v"
}

_gstack_node_try() { # RULE FILE ACCEPT [WANT]
  local real ver
  [ -x "$2" ] || return 1
  real=$(gstack_realpath "$2") || return 1
  ver=$(gstack_node_version "$real") || return 1
  [ -z "${4:-}" ] || [ "$ver" = "$4" ] || return 1
  "$3" "$ver" || return 1
  _gn_bin="$real" _gn_ver="$ver" _gn_rule="$1"
}

# gstack_node_resolve STORE "WANTED VERSIONS" ACCEPT — sets _gn_bin (realpath),
# _gn_ver and _gn_rule (PATH|store|nvm); returns 1 when nothing qualifies.
# ACCEPT VERSION returns 0 when VERSION satisfies every project Node pin.
gstack_node_resolve() {
  local store="$1" wanted="$2" accept="$3" v dir first nvm="${NVM_DIR:-$HOME/.nvm}" gifs
  _gn_bin="" _gn_ver="" _gn_rule=""
  first=$(command -v node 2>/dev/null || true)
  [ -n "$first" ] && _gstack_node_try PATH "$first" "$accept" && return 0
  for v in $wanted; do
    _gstack_node_try store "$store/$v/bin/node" "$accept" "$v" && return 0
    _gstack_node_try nvm "$nvm/versions/node/v$v/bin/node" "$accept" "$v" && return 0
  done
  gifs=$IFS; IFS=:
  for dir in $PATH; do
    IFS=$gifs
    [ -n "$dir" ] && _gstack_node_try PATH "$dir/node" "$accept" && return 0
  done
  IFS=$gifs
  return 1
}

# gstack_node_target — the release archive suffix for this machine.
gstack_node_target() {
  case "$(uname -ms)" in
    'Linux x86_64') echo linux-x64 ;;
    'Linux aarch64'|'Linux arm64') echo linux-arm64 ;;
    'Darwin x86_64') echo darwin-x64 ;;
    'Darwin arm64') echo darwin-arm64 ;;
    *) return 1 ;;
  esac
}

# gstack_node_install STORE VERSION — download, verify and publish Node VERSION
# at STORE/VERSION; on failure prints one reason and returns 1.
gstack_node_install() {
  local store="$1" v="$2" target base tmp want got
  target=$(gstack_node_target) || { echo "no Node release archive for $(uname -ms)"; return 1; }
  base="${GSTACK_NODE_DIST_URL:-https://nodejs.org/dist}/v$v"
  [ -x "$store/$v/bin/node" ] && [ "$(gstack_node_version "$store/$v/bin/node")" = "$v" ] && return 0
  mkdir -p "$store" || { echo "cannot create the runtime store $store"; return 1; }
  tmp=$(mktemp -d "$store/.tmp.XXXXXX") || { echo "cannot create a temp dir in $store"; return 1; }
  if ! curl --retry 3 -fsSL "$base/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt" \
     || ! curl --retry 3 -fsSL "$base/node-v$v-$target.tar.gz" -o "$tmp/node.tar.gz"; then
    rm -rf "$tmp"; echo "could not download node-v$v-$target.tar.gz or SHASUMS256.txt from $base"; return 1
  fi
  want=$(awk -v f="node-v$v-$target.tar.gz" '$2 == f { print $1 }' "$tmp/SHASUMS256.txt" | head -1)
  if command -v sha256sum >/dev/null 2>&1; then got=$(sha256sum "$tmp/node.tar.gz" | cut -d' ' -f1)
  else got=$(shasum -a 256 "$tmp/node.tar.gz" | cut -d' ' -f1); fi
  if [ -z "$want" ] || [ "$want" != "$got" ]; then
    rm -rf "$tmp"; echo "node-v$v-$target.tar.gz SHA-256 ${got:-unreadable} does not match SHASUMS256.txt (${want:-no entry}); nothing installed"; return 1
  fi
  mkdir "$tmp/pub" && tar -xzf "$tmp/node.tar.gz" -C "$tmp/pub" --strip-components 1 \
    || { rm -rf "$tmp"; echo "could not unpack node-v$v-$target.tar.gz"; return 1; }
  got=$(gstack_node_version "$tmp/pub/bin/node")
  [ "$got" = "$v" ] || { rm -rf "$tmp"; echo "the downloaded node reports ${got:-nothing}, expected $v; nothing installed"; return 1; }
  rm -rf "$store/$v" && mv -T "$tmp/pub" "$store/$v" || { rm -rf "$tmp"; echo "could not publish $store/$v"; return 1; }
  rm -rf "$tmp"
}

# gstack_launch_dir DIR BUN [NODE] — publish DIR holding only symlinks to BUN
# (as bun and bunx) and NODE with its npm, npx and corepack, so the launch
# PATH never exposes a shared bin directory's other tools. Each entry is
# renamed into place; entries for a dropped NODE are removed.
gstack_launch_dir() {
  local dir="$1" bun="$2" node="${3:-}" name src tmp
  mkdir -p "$dir" || return 1
  tmp=$(mktemp -d "$dir.tmp.XXXXXX") || return 1
  ln -s "$bun" "$tmp/bun" && ln -s "$bun" "$tmp/bunx" || { rm -rf "$tmp"; return 1; }
  if [ -n "$node" ]; then
    ln -s "$node" "$tmp/node" || { rm -rf "$tmp"; return 1; }
    for name in npm npx corepack; do
      src="$(dirname "$node")/$name"
      { [ -e "$src" ] || [ -L "$src" ]; } && ln -s "$src" "$tmp/$name"
    done
  fi
  for name in bun bunx node npm npx corepack; do
    if [ -L "$tmp/$name" ]; then mv -fT "$tmp/$name" "$dir/$name" || { rm -rf "$tmp"; return 1; }
    else rm -f "$dir/$name"; fi
  done
  rm -rf "$tmp"
}
