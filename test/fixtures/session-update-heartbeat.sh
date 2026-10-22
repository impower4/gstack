#!/usr/bin/env bash
# Exercise the actual updater heartbeat block without git, setup or account state.
set +e
source_file=$1
MODE=$2
FIXTURE=$3
export MODE FIXTURE
mkdir "$FIXTURE/bin" || exit 90
cat > "$FIXTURE/bin/sleep" <<'SH'
#!/usr/bin/env bash
if [ "$1" = 300 ]; then
  echo "$$" > "$FIXTURE/sleeper.pid"
  exec /bin/sleep 30
fi
exec /bin/sleep "$@"
SH
chmod 700 "$FIXTURE/bin/sleep"
export PATH="$FIXTURE/bin:/usr/bin:/bin"

# Only this bounded lifecycle block is evaluated; never the full updater.
lifecycle=$(sed -n '/^  # In-flight heartbeat:/,/^  # ── Fetch, check/{ /^  # ── Fetch, check/d; p; }' "$source_file")
[ -n "$lifecycle" ] || exit 91
cat > "$FIXTURE/holder.sh" <<'SH'
set +e
LOCK_DIR="$FIXTURE/lock"
mkdir "$LOCK_DIR" || exit 92
MYPID="${BASHPID:-$(sh -c 'echo $PPID')}"
echo "$MYPID" > "$LOCK_DIR/pid"
SH
printf '%s\n' "$lifecycle" >> "$FIXTURE/holder.sh"
cat >> "$FIXTURE/holder.sh" <<'SH'
echo "$HB_PID" > "$FIXTURE/heartbeat.pid"
attempt=0
while [ "$attempt" -lt 100 ]; do
  [ -f "$FIXTURE/sleeper.pid" ] && break
  /bin/sleep .01
  attempt=$((attempt + 1))
done
[ -f "$FIXTURE/sleeper.pid" ] || exit 93
touch "$FIXTURE/ready"
while [ ! -f "$FIXTURE/finish" ]; do /bin/sleep .01; done
[ "$MODE" = failure ] && exit 7
exit 0
SH

/bin/sleep 30 &
sentinel=$!
holder=""
cleanup_fixture() {
  # These exact PIDs were created in this private fixture, never process groups.
  [ -n "$holder" ] && kill "$holder" 2>/dev/null
  for file in heartbeat.pid sleeper.pid; do
    if [ -f "$FIXTURE/$file" ]; then
      candidate=$(cat "$FIXTURE/$file")
      kill -0 "$candidate" 2>/dev/null && kill "$candidate" 2>/dev/null
    fi
  done
  kill "$sentinel" 2>/dev/null
  wait "$sentinel" 2>/dev/null
  [ -n "$holder" ] && wait "$holder" 2>/dev/null
}
trap cleanup_fixture EXIT
bash "$FIXTURE/holder.sh" &
holder=$!
attempt=0
while [ "$attempt" -lt 100 ]; do
  [ -f "$FIXTURE/ready" ] && break
  /bin/sleep .01
  attempt=$((attempt + 1))
done
[ -f "$FIXTURE/ready" ] || exit 94
heartbeat=$(cat "$FIXTURE/heartbeat.pid")
sleeper=$(cat "$FIXTURE/sleeper.pid")
case "$MODE" in
  TERM|HUP) kill -s "$MODE" "$holder" ;;
  reclaimed) echo "$sentinel" > "$FIXTURE/lock/pid"; touch "$FIXTURE/finish" ;;
  normal|failure) touch "$FIXTURE/finish" ;;
  *) exit 95 ;;
esac
wait "$holder"
status=$?
holder=""
expected=0
case "$MODE" in
  failure) expected=7 ;;
  TERM) expected=143 ;;
  HUP) expected=129 ;;
esac
[ "$status" = "$expected" ] || exit 96
kill -0 "$sentinel" 2>/dev/null || exit 97
! kill -0 "$heartbeat" 2>/dev/null || exit 98
! kill -0 "$sleeper" 2>/dev/null || exit 99
if [ "$MODE" = reclaimed ]; then
  [ "$(cat "$FIXTURE/lock/pid")" = "$sentinel" ] || exit 100
else
  [ ! -e "$FIXTURE/lock" ] || exit 101
fi
# Successful assertions precede fixture-owned sentinel cleanup.
printf 'closed status=%s sentinel=alive heartbeat=absent sleeper=absent\n' "$status"
