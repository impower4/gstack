#!/bin/sh
# gstack-design-claim — publish a staged design image without overwriting.
#
# Usage: gstack-design-claim <staged-image> <destination>
#
# Creates <destination> with an exclusive, non-overwriting create (set -C
# noclobber, which opens with O_EXCL). When the name is taken it tries
# <stem>-2<ext>, <stem>-3<ext> ... <stem>-999<ext>, the same rule as
# $D's claimOutputPath (x-2.png bumps to x-2-2.png). Prints the final path.
# On any failure it exits non-zero with problem/cause/fix and leaves the staged
# image in place, so the paid bytes survive. On success the staged copy is
# removed.

set -u

fail() {
  printf 'gstack-design-claim: %s\ncause: %s\nfix: %s\n' "$1" "$2" "$3" >&2
  exit 1
}

[ "$#" -eq 2 ] || fail "expected 2 arguments, got $#" "usage: gstack-design-claim <staged-image> <destination>" "pass the staged image path, then the destination path"
src=$1
dest=$2

[ -f "$src" ] && [ -s "$src" ] || fail "staged image $src is missing or empty" "the generating command did not save an image there" "use the outputPath the \$D command printed"

dir=$(dirname "$dest")
base=$(basename "$dest")
case "$base" in
  ?*.*) stem=${base%.*}; ext=".${base##*.}" ;;
  *) stem=$base; ext="" ;;
esac

err=$(mkdir -p "$dir" 2>&1) || fail "cannot create $dir; staged image kept at $src" "$err" "make $dir writable or choose another destination"

n=1
candidate=$dest
while :; do
  if err=$( (set -C; : > "$candidate") 2>&1 ); then
    if err=$(cat "$src" 2>&1 > "$candidate"); then
      rm -f "$src"
      printf '%s\n' "$candidate"
      exit 0
    fi
    rm -f "$candidate"
    fail "cannot write $candidate; staged image kept at $src" "$err" "free disk space or make $dir writable, then rerun"
  fi
  if [ -e "$candidate" ] || [ -L "$candidate" ]; then
    n=$((n + 1))
    [ "$n" -le 999 ] || fail "$dest and every name through $stem-999$ext already exist; staged image kept at $src" "999 images already use this name" "choose a new destination name or move older images out of $dir"
    candidate="$dir/$stem-$n$ext"
    continue
  fi
  fail "cannot create $candidate; staged image kept at $src" "$err" "make $dir writable or choose another destination"
done
