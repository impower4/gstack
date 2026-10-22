# shellcheck shell=bash
# gstack-sanitize-echo.sh — the Bash twin of lib/sanitize-echo.ts, the one
# sanitizer for an external string gstack echoes into a message, a log line or
# a key=value state file (command output, stderr, a version string, a path).
# Sourced, never executed. test/sanitize-echo.test.ts runs both twins, under
# bash, zsh and bash --posix, on one table.
#
# gstack_sanitize_echo [TEXT] — TEXT (stdin when no argument): CR, LF and TAB
# become spaces, every other ASCII control byte (ESC included) and DEL is
# removed, runs of spaces collapse, and at most 200 bytes of valid UTF-8 with
# no leading or trailing space are printed, then a newline.
gstack_sanitize_echo() {
  { if [ "$#" -gt 0 ]; then printf '%s' "$1"; else cat; fi; } |
    LC_ALL=C tr '\r\n\t' '   ' | LC_ALL=C tr -d '\000-\037\177' | LC_ALL=C tr -s ' ' |
    LC_ALL=C sed -e 's/^ //' | head -c 200 |
    LC_ALL=C sed -E -e "s/($(printf '[\360-\377][\200-\277][\200-\277]|[\340-\377][\200-\277]|[\300-\377]'))\$//" -e 's/ $//' |
    LC_ALL=C tr -d '\n'
  printf '\n'
}
