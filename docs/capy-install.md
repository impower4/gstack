# Installing gstack on a Capy cloud machine

Three layers, each owned by gstack:

| Layer | Where | Job |
|---|---|---|
| Bootstrapper | `capy/skill/gstack/scripts/install.sh` (copied once into the owner's Drive skill folder; frozen) | clone when absent; fetch origin's default branch and read the supported minimum from `FETCH_HEAD:capy/support.env`; in install mode fast-forward a clean, unpinned checkout below it; exec the full wrapper |
| Full wrapper | `bin/gstack-capy-session` (moves with the checkout) | map the session start onto the installer: `--check` certifies (and reports a checkout behind origin), otherwise fast-forward a checkout behind origin (`bin/gstack-upgrade --ff-only-no-reinstall`), then install or repair |
| Installer | `bin/gstack-capy-install` | Bun, both host profiles, the doctor, the install verdict, the launch line, the trailer |

The vendored skill (`capy/skill/gstack/SKILL.md`) tells a Capy agent how to use
them. The Drive folder is a mirror: the owner copies `capy/skill/gstack/` there
when asked; nothing writes the Drive automatically.

Direct use, without the Drive skill (a subagent or reviewer machine): clone into
the root the bootstrapper resolves when nothing is there, then run the
checkout's own bootstrapper by absolute path, from the project directory, so
the floor check and fast-forward still run and the verdict is keyed by the
caller's project. The same command serves every later session (an existing
checkout is fast-forwarded, never re-cloned):

```bash
test -f "$HOME/.local/share/gstack/setup" || git clone --quiet --single-branch --depth 1 https://github.com/garrytan/gstack.git "$HOME/.local/share/gstack" && GSTACK_CAPY_ROOT="$HOME/.local/share/gstack" bash "$HOME/.local/share/gstack/capy/skill/gstack/scripts/install.sh" --for autoplan
```

The text comes from `capyBootstrapCommand` in `lib/doctor-components.ts`
(Bash: `gstack_capy_bootstrap_cmd`); the not-installed fix lines print it with
the root they checked.

## Reviewer machines: `--for review-voice`

A dispatched reviewer (an /autoplan voice, a second opinion) reads a plan and
reports; it runs no workflow. `--for review-voice` gives its machine a real
trailer in seconds: clone or fast-forward, Bun at gstack's own supported
minimum (the project's pins are not applied, since no repo tests run there; the
trailer says `pins: skipped (helper runtime)`), no `./setup`, no host profiles
and no bun shim. The doctor certifies only the read-only helpers (`PASS
helpers`: `gstack-pregate sealed`, `gstack-plan-reality`, `gstack-artifact` and
the `gstack-autoplan` reads such as `status` and `contract`). Its verdict covers
no host profile, so a workflow started there is refused (`INSTALL: fail verdict
— … (review-voice certifies only the read-only helpers); fix: run
GSTACK_CAPY_ROOT=<root> bash <root>/capy/skill/gstack/scripts/install.sh --for
<skill> …`). A review-voice check never replaces an ok verdict that a fuller
install wrote for the same HEAD and project. Every /autoplan reviewer prompt
ends with this command (`GSTACK TRAILER`); the warm run's budget, under 20 s,
is measured by `test/capy-review-voice.test.ts`.

## Session start

1. `bash <skill>/scripts/install.sh --check --for <skill>` (under a second when
   a checkout exists). It fetches refs only and never moves the checkout. With
   no checkout it prints `gstack: fail not-installed — ...` and the session
   records that line and continues when it runs no gstack workflow; install
   right before the first workflow.
2. When the trailer is `gstack: fail revision ...` or `gstack: fail runtime ...`
   and a checkout exists, run the same command without `--check`. Below the
   supported minimum, a clean checkout on the remote default branch is
   fast-forwarded (`gstack-capy-skill: upgraded <old> -> <new>`), reinstalled
   and rechecked as one transaction under `.gstack-capy-install.lock` (the
   bootstrapper holds it and hands it over with `GSTACK_CAPY_LOCK_HELD=1`).
   A pinned (`--revision`, detached HEAD, another branch), dirty or diverged
   checkout is never moved; the trailer names the cause and the exact commands
   ([REVISION_BELOW_MINIMUM](troubleshooting.md#revision-below-minimum)).
   `GSTACK_CAPY_AUTO_UPGRADE=0` disables the fast-forward.
3. The minimum is the floor, not the trigger. Above it, a checkout behind
   origin's default branch still moves at install-mode session start: the
   full wrapper runs `bin/gstack-upgrade --ff-only-no-reinstall` (every
   refusal of `gstack-upgrade` applies), prints `SELF_UPGRADE: done <old> ->
   <new>` and re-execs the new checkout's wrapper, which installs from the
   new revision (`GSTACK_CAPY_UPGRADED_FROM` set, so setup is never skipped).
   A refusal prints `SELF_UPGRADE: skipped (<reason>)`, and the session is
   never certified ok: the trailer is `gstack: fail behind — installed <rev> is
   <n> commits behind origin (latest <ver>) and the session-start upgrade was
   skipped: <reason>; fix: <command> (UPGRADE_BUSY|UPGRADE_REFUSED)`, exit 1.
   `SELF_UPGRADE: none (current)` when nothing is ahead;
   `GSTACK_CAPY_SELF_UPGRADE=off` (or `GSTACK_CAPY_AUTO_UPGRADE=0`) prints
   `SELF_UPGRADE: disabled (<variable>)`. `--check` never moves the checkout;
   behind origin it prints `gstack-capy-session: behind origin/<branch>:
   <installed> -> <remote> (<n> commits); fix: bash <skill>/scripts/install.sh
   [--for <skill>] (fast-forwards)` and the agent runs that fix. Whenever the
   session ends behind origin (`--check`, or a self-upgrade that was skipped or
   disabled), the ok trailer also says so, because lanes relay only the
   trailer: `behind=<n> (latest: <ver>); fix: <command>` (see the trailer
   grammar below).
4. When the fetch fails (offline), the bootstrapper says `remote minimum
   unknown (fetch failed)` and checks the local install only; it never claims
   the minimum, and nothing is fast-forwarded.

The upgrade target is always the tip of the default branch: every commit there
is a stamped release that passed CI. Recovery runs forward, never back: an
install interrupted after a fast-forward leaves the trailer `fail`, and the
next install or `bin/gstack-upgrade` run completes the pending install stages
(setup is never skipped after a fast-forward) or refuses and names the cause.
Checking out an older commit is not a supported rollback; it does not undo
setup migrations that already ran.

Between minimums, `bin/gstack-upgrade --check` says `current <v>` or `behind
<installed> -> <remote> (<n> commits)`, and `bin/gstack-upgrade` fast-forwards
and reinstalls (`bin/gstack-capy-install` on a Capy install, else `./setup
--refresh-registered`). It refuses a dirty, diverged or pinned checkout with
[UPGRADE_REFUSED](troubleshooting.md#upgrade-refused) and never stashes or
resets.

Several agents sharing one checkout (eight Capy subagents on a machine) hold
workflow leases on it: every `bin/gstack-skill-start` touches
`<git dir>/gstack-leases/<harness pid>` (`bin/gstack-lease touch`; pruned after
120 minutes). Each lease records its process's start identity (Linux: boot id
and `/proc` start time; elsewhere `ps -o lstart`), because a pid is reused after
a reboot or a machine wake. `bin/gstack-upgrade`, and so the session-start
self-upgrade, refuses with [UPGRADE_BUSY](troubleshooting.md#upgrade-busy)
while a lease held by a live process outside its own chain exists, naming each
holder as `pid <p> (<age>m <command>)`. A lease whose pid now belongs to another
process, or an identity-less lease from an older gstack past 120 minutes, is
stale: `bin/gstack-lease live` reclaims it (`gstack-lease: reclaimed stale
lease …`). Stale needs proof: two well-formed identities from the same backend
that differ (`ps` is read under `LC_ALL=C TZ=UTC0`). An identity that cannot be
read, a malformed record or a backend change keeps the lease. `touch` (publish
by rename, prune) and reclaim (reread, then delete only the record judged
stale) run under one lock in the lease directory, a symlink naming its holder's
pid and start identity, so a renewal is never deleted and a live lease never
disappears from a concurrent scan. The lock is broken only when its holder is
dead or its pid was reused, never by age, and breakers serialize on a second
symlink and reread the lock before removing it. One killed gstack-lease process
is always safe; two killed in a row, one holding the lock and the next while
breaking it, can still let a reclaim delete a renewal. While a live process holds it,
`touch` exits 3 without writing (`gstack-skill-start` reports that the
session holds no lease) and a reclaim keeps the lease. `bin/gstack-lease list` shows `alive|dead|stale`, and
`GSTACK_UPGRADE_FORCE=1` overrides.

## What the installer does

1. Reuses the checkout it lives in (or clones into `--root <dir>`), under the
   lock. It never resets or pulls; `--revision <ref>` pins a fresh clone, and an
   existing checkout at another revision is reused with the trailer note
   `requested: <ref> (run <checkout>/bin/gstack-upgrade to move)`. A fresh
   clone prints `cloned <repo> at <sha12> (<version>)` (the bootstrapper's
   clone too, through `GSTACK_CAPY_CLONED`).
2. Preflight: `git`, `curl`, `node`, `jq`, then Bun. The project's pins
   (`--project <path>`, default the git toplevel of the current directory) are
   read with the doctor's own parser (`bin/gstack-runtime-pins.ts`: engines,
   packageManager, `.tool-versions`, `.bun-version` and CI `bun-version:` lanes
   for this platform). CI exact pins for this platform are alternatives: a
   repository may test several Bun versions (gstack's own CI pins 1.4.2 and
   runs one job on 1.4.3), so a Bun equal to any one of them satisfies CI;
   CI ranges and every non-CI pin stay required. One resolver picks the Bun (`gstack_bun_resolve` in
   `bin/gstack-bun-version.sh`; `resolveBun` in `lib/pregate/runtime.ts` is
   its TypeScript twin), and the installer, `--check`, the doctor, the bun
   shim and install admission all use it. Candidates, first eligible wins:
   the store copy of the project's exact pin (rule `pin`), the store copy of
   the install default (`default`), `$BUN_INSTALL/bin/bun`, `~/.bun/bin/bun`
   (`home`), then every `bun` on PATH. Eligible means it runs, reports a
   version at or above the supported minimum (1.4.2) and satisfies the
   project's pins. When nothing qualifies, the installer downloads one exact
   release archive, verifies its SHA-256 against `bin/gstack-bun-version.sh`
   and unpacks it into the versioned store
   `<state root>/runtimes/bun/<version>/bun`, under `~/.gstack-runtime.lock`.
   Each version directory also holds `bunx -> bun`. A broken entry is
   repaired without a window (its files are renamed over their predecessors),
   and `~/.bun/bin` is never written. The archive is the project's non-CI
   exact pin when gstack carries a verified archive for it
   (`GSTACK_BUN_VERIFIED`: 1.4.2, 1.4.3); with only CI exact pins, the install
   default when it is one of them, else the highest verified one; else the
   install default `GSTACK_BUN_DEFAULT` (1.4.3, above the 1.4.2 minimum; one
   CI job runs the quick free tier on it).
   `GSTACK_BUN_INSTALL_VERSION=<v>` overrides the default; a version without a
   verified archive or below the minimum stops the install
   ([BUN_INSTALL_VERSION_INVALID](troubleshooting.md#bun-install-version-invalid)).
   With a non-CI exact pin, only that version satisfies it. Any other exact
   pin (below the minimum, two different non-CI ones, or one without a verified
   archive), or a range gstack's minimum does not satisfy, stops with both
   constraints ([RUNTIME_PIN_CONFLICT](troubleshooting.md#capy-install-runtime-conflict),
   exit 3) before `./setup`. With no Bun at or above the security floor, the
   default is installed first so the pins can be read.

   Node follows the same rule (`bin/gstack-node-runtime.sh`): `engines.node`,
   `.nvmrc`, `.tool-versions` and CI `node-version:` lanes, non-CI exact pins
   required and CI exact pins in different jobs alternatives. The first node
   that satisfies them wins: the node first on PATH (rule `PATH`), then for
   each wanted version gstack's store copy
   `<state root>/runtimes/node/<version>/bin/node` (`store`) and nvm's
   `${NVM_DIR:-~/.nvm}/versions/node/v<version>/bin/node` (`nvm`), then every
   other `node` on PATH. When nothing qualifies and the project names an exact
   version, install mode downloads `node-v<version>-<target>.tar.gz` and
   `SHASUMS256.txt` from `https://nodejs.org/dist/v<version>/`
   (`GSTACK_NODE_DIST_URL` overrides the base), checks the archive's SHA-256
   against that list and publishes the tree in the store by rename. A CI-only
   pin set installs its highest version. `/usr/local/bin` and nvm are never
   written. Two different non-CI exact Node pins stop with
   [RUNTIME_PIN_CONFLICT](troubleshooting.md#capy-install-runtime-conflict).
   `--check` keeps the recorded Node while it still reports its version and
   satisfies the pins, and never installs one; the doctor's `pins` row reads
   whatever node the launch PATH gives, and a Node mismatch names the node it
   read and the installer command that fixes it.
3. `./setup --host claude --no-prefix`, then `./setup --host codex --model
   gpt-6-astra`, both with `--no-browser`. Skipped when this exact HEAD was set
   up with the same hosts, model and browser flag (recorded in the git dir
   after a successful setup) and `gstack-doctor --check` passes; a warm rerun
   takes about a second. Each setup ends with its own `gstack ready (<host>)`;
   the installer then prints `gstack ready (claude, codex)`.
4. `gstack-doctor --check` for the requested workflow (`--for <skill>`,
   `--only <skill>`, or `--require <id,id>`; default `claude,codex,patch`),
   run with the launch PATH, so the trailer certifies the Bun workflows run.
5. The install verdict (schema 2), written atomically to
   `<state root>/install-verdicts/<sha256 of the checkout realpath>/<sha256 of the project realpath, or "none">.json`:
   checkout, project, HEAD, the workflow and required components it
   certified, whether pins were skipped as planning-only, the pin it
   honoured, the resolved Bun (`bun_path`, `bun_version`, `bun_rule`, and
   `bun_install` when this run downloaded it), the resolved Node when the
   project pins one (`node_path`, `node_version`, `node_rule`), the trailer, the remote
   minimum, the launch PATH and the time. Admission refuses a workflow whose
   running Bun is not the one the verdict recorded
   ([BUN_RESOLUTION_DRIFT](troubleshooting.md#bun-resolution-drift)), and so
   do the pregate's lanes and guards, which also refuse an invalid verdict
   ([INSTALL_UNVERIFIED](troubleshooting.md#install-unverified)) under
   `GSTACK_CAPY=1` or whenever a verdict exists. `--check` keeps the recorded
   Bun while it exists, reports the recorded version and satisfies the pins;
   a candidate that would now resolve first is a `note:` line, and only a
   recorded Bun that is gone, changed or no longer satisfies the pins fails
   the doctor's `runtime` row. A schema 1 verdict (keyed by checkout only) is
   still read.
6. On a Capy machine (`CAPY_MACHINE_CONFIG` set or `~/.capy/system` present),
   install mode writes the bun shims described below.

`--check` runs only steps 4 and 5 (no clone, Bun install, setup or shim).

## The bun shim

A fresh shell on Capy finds the image's `/usr/local/bin/bun` (1.3.14) first,
so a `bun test` typed without the `GSTACK_LAUNCH` prefix used to run the wrong
Bun. Install mode therefore writes `~/.local/bin/bun` and `~/.local/bin/bunx`
(`~/.local/bin` precedes `/usr/local/bin` on the Capy image's PATH). Each is a
small POSIX script whose second line is the marker
`# gstack-bun-shim: gstack-owned; delete this file to remove it`. At every
call the `bun` shim finds the git toplevel around the working directory and
runs, in order: the Bun that project's install verdict recorded (the `none`
verdict outside any project and inside the gstack checkout), the store copy
of the project's exact pin, the store copy of the install default, then
`$BUN_INSTALL/bin/bun`, `~/.bun/bin/bun` and every non-shim `bun` on PATH,
first at or above the supported minimum, then at or above the security
floor. A pin is used only when it is `x.y.z` and its store entry is a real
binary inside the store (no `..`, symlink escape or shim-marked file). A
project pinning a Bun the store lacks prints `gstack bun shim: <root> pins
bun <v>, which is not in gstack's runtime store; run ... --check here`;
an unrecorded, unpinned repo falls through quietly. `bunx` runs `bun x`
through the `bun` shim beside it.

- `GSTACK_BUN_SHIM_EXPLAIN=1 bun --version` prints
  `gstack bun shim: project=<root> record=<file> chose=<bun> rule=<rule>`
  (and names a missing record).
- `GSTACK_BUN_SHIM=0` at install time writes no shim.
- Removing it: delete `~/.local/bin/bun` and `~/.local/bin/bunx`. gstack
  replaces only a missing file or a file carrying the marker; a foreign file
  or a dangling link there is left untouched with a note, and the
  `GSTACK_LAUNCH` prefix stays the way to reach the certified Bun.
- The doctor's `runtime` row notes the shim; the resolver never treats a
  shim-marked file as a Bun candidate.

## The one line to grep

The last line is the trailer:

```
gstack: ok 1.91.96.0 for=autoplan
gstack: ok 1.91.96.0 for=review (requested: v1.91.90.0 (run <checkout>/bin/gstack-upgrade to move); latest: 1.91.101.0 available)
gstack: ok 1.91.96.0 for=autoplan (pins: skipped (planning-only))
gstack: ok 1.91.101.0 for=autoplan (behind=12 (latest: 1.91.107.0); fix: bash <skill>/scripts/install.sh --for autoplan)
gstack: fail runtime,pins
```

An ok trailer carries at most one parenthesised note group, `; `-separated,
in this order: `requested: …` (an existing checkout at another revision than
`--revision`), `pins: skipped (planning-only|no project|helper runtime)`, then either
`behind=<n> (latest: <ver>)` followed by `fix: <command>` (the session ended
<n> commits behind origin's default branch after a fetch that succeeded in this
run; `bin/gstack-capy-session` exports `GSTACK_CAPY_BEHIND`, `_BEHIND_TO` and
`_BEHIND_FIX`, so this works with every bootstrapper revision), or `latest:
<ver> available` (origin's default branch has a newer VERSION; the bootstrapper
exports it as `GSTACK_CAPY_REMOTE_VERSION` only after a fetch that succeeded
in this run). A fail trailer never carries notes. Match `^gstack: ok ` or
`^gstack: fail `; never parse past the first space after the version.

Exit 0 only with `gstack: ok`. Read the exit status and the trailer directly:

```bash
out=$(bash <skill>/scripts/install.sh --check --for autoplan 2>&1); rc=$?
printf '%s\n' "$out" | grep '^gstack: '
[ "$rc" -eq 0 ]
```

Never pipe `--check` (or the installer) through `tail`, `head` or `grep`
alone: the pipe's exit status replaces the doctor's, and a silent failure is
the incident this installer exists to end. Every `FAIL <id>` row carries a
`fix:` clause and a reason code with its [troubleshooting
anchor](troubleshooting.md#install-check-gstack-doctor---check-and-the-capy-installer).
A parent agent confirms each subagent machine with this grep; one machine's
install never covers another, and a subagent's first report carries its own
`gstack:` line.

`SKIP pins (planning-only; repo pins differ: ..., launch bun <v>)` (trailer
note `pins: skipped (planning-only)`) is not a
failure: planning workflows (`--for autoplan`, the plan reviews,
`office-hours`) never run the target repo's tests. Workflows that do (`review`,
`ship`, `qa`) and `--require` keep `pins` required.

When a lane reports to another thread (a handoff, a `gstack-lane-check`
result, a coordinator contract), store and use the full thread id (`jam_…`)
in the message, never the short display code: the code is a label the app
renders, the id is what another agent can address and what the evidence bundle
records. `UBI_OWNER` and lane ownership records take the same full id.

## Browser

The default install prints `SKIP browser (lazy; gstack-browser-ensure
installs on first use)` and downloads nothing. The first browser skill run
(`/browse`, `/qa`, `/design-review`, ...) calls `bin/gstack-browser-ensure`
from its preflight, which installs Chromium (~115 MiB, about 86 s on a Capy
machine) under setup's lock and prints `BROWSER_OK` or `BROWSER_UNAVAILABLE
<reason>`. `--with-browser` installs it during the install instead, and the
installer then prints the planning-only install time and the browser bootstrap
time separately.

## The launch line

Every successful run, `--check` included, prints before the trailer:

```
GSTACK_LAUNCH: PATH=<dir>:$PATH GSTACK_SESSION_KIND=unattended GSTACK_STATE_ROOT=<path> GSTACK_EPHEMERAL=1 GSTACK_CAPY=1 GSTACK_INSTALL_VERDICT=<file>
GSTACK_LAUNCH_PATH: <dir>
```

`PATH=<dir>:$PATH` and `GSTACK_LAUNCH_PATH` appear only when the certified Bun,
or the project's resolved Node, is not first on PATH (older Capy images ship
`/usr/local/bin/bun` 1.3.14; 57 gstack commands start with `#!/usr/bin/env bun`).
`<dir>` is never a shared bin directory: a Bun from gstack's store launches
from its own version directory, and any other Bun, or a Node the launch
needs, launches through `<verdict file without .json>.launch`, a gstack-owned
directory holding only `bun`, `bunx` and, when needed, `node`, `npm`, `npx` and
`corepack` symlinks. So a Bun found in `/usr/local/bin` or `$BUN_INSTALL/bin`
never puts that directory's other tools (the image's node) in front of PATH.
The pregate's lanes launch through the same directory. A child shell's `export` cannot
configure the parent's later commands, so the parent supplies these
assignments to every gstack command it launches (prefix the command, or
export them once in the shell that runs it). A fresh shell without them keeps
reporting the Bun it would really run: `FAIL runtime — bun 1.3.14 at
/usr/local/bin/bun ...; verified bun 1.4.2 found at ~/.bun/bin (not on PATH);
fix: export PATH="$HOME/.bun/bin:$PATH" or prefix commands with the
GSTACK_LAUNCH line`.

`GSTACK_EPHEMERAL=1` tells gstack the disk vanishes with the machine, so the
doctor's `state root` row reads `durable=no` and unattended runs say
`learnings: skipped` instead of writing silently. A durable root is opt-in:
set `GSTACK_STATE_ROOT` to a directory that outlives the machine. The
installer never writes to the Capy drive. See
[docs/state-root.md](state-root.md#ephemeral-machines).

`GSTACK_CAPY=1` turns on install admission. An unattended session (any host)
refuses to start a workflow on a Bun below the supported minimum; with
`GSTACK_CAPY=1`, an unattended or `GSTACK_SESSION_KIND=spawned` session also
needs a passing verdict for this checkout, its current HEAD and a workflow at
least as wide as the one starting. A refusal prints `INSTALL: fail ...` and
`GSTACK_RESULT: skill=<s> status=refused run=-` and exits 3
([INSTALL_UNVERIFIED](troubleshooting.md#install-unverified)). Ambient
spawned sessions (OpenClaw) only warn. `GSTACK_ALLOW_UNSUPPORTED_RUNTIME=1`
admits anyway and says so.

## Bake into a Capy snapshot

Machines that never run a workflow should not pay the install (about 30 s
cold). A project that runs gstack on most machines can bake it instead: the
project Setup's initialize step runs

```bash
git clone --single-branch --depth 1 https://github.com/garrytan/gstack.git ~/.local/share/gstack
~/.local/share/gstack/bin/gstack-capy-install --require claude,codex,patch
```

and snapshots capture `$HOME` (the checkout, `~/.bun/bin`, both host
profiles). Each session then pays only the `--check`. A baked revision still
moves forward at install-mode session start whenever it is behind origin, and
the baked `~/.bun/bin` reaches workflows through the `GSTACK_LAUNCH` line. The
project Setup is shared by every thread in the project, so changing it is the
project's decision.

## Working under a Captain

In a Capy session (`GSTACK_CAPY=1`, set by the launch line) every workflow
prints `CAPY: on` and a `capy-asks` block: decisions go through Capy (a crew
thread asks its Captain, otherwise the person), plan approvals are rendered
with `gstack-owner-brief render --captain`, answers are recorded with
`gstack-approvals`, and /ship's PR body opens with before/after images
(`gstack-pr-shots`), Why and Approvals. The guide is
[`capy/skill/gstack/captain.md`](../capy/skill/gstack/captain.md);
`GSTACK_CAPY_ASKS=0` drops the block for one session.

## Raising the supported minimum

`capy/support.env` holds `GSTACK_MIN_REVISION` and `GSTACK_CAPY_MIN_WRAPPER`.
Raise `GSTACK_MIN_REVISION` only for install-honesty or security fixes, at
stamp time, to the VERSION being released: it is the floor below which the
trailer fails and the bootstrapper itself fast-forwards (a checkout above it
that is behind origin is fast-forwarded by the checkout's own wrapper, so the
floor is not what keeps machines current). It never exceeds VERSION
(test/capy-skill-wrapper.test.ts). Raise `GSTACK_CAPY_MIN_WRAPPER` together with
`GSTACK_CAPY_WRAPPER` in the bootstrapper when the bootstrapper itself
changes in a way older copies cannot work with; older Drive copies keep
working and print an owner action
([CAPY_WRAPPER_STALE](troubleshooting.md#capy-wrapper-stale)), and the
doctor's `wrapper` row warns (an active copy below the minimum is a WARN,
never a FAIL; `bin/gstack-upgrade` never leaves a pending reinstall for it).
Wrapper 2 only adds optional exports (the trailer's `latest:` note and the
`cloned` line), so the minimum stays 1.

## Exit codes

| Exit | Meaning |
|-----:|---------|
| 0 | `gstack: ok` — every required component passed |
| 1 | `gstack: fail <ids>` — a required component failed; each row has a fix |
| 2 | usage error |
| 3 | preflight stopped before `./setup` (`INSTALL_PREFLIGHT_FAILED`, `RUNTIME_PIN_CONFLICT`); nothing was installed |
