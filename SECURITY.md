# Security Policy

## Reporting a vulnerability

Please report security vulnerabilities privately, not in public issues,
pull requests, or discussions.

**Preferred:** use GitHub private vulnerability reporting:
<https://github.com/garrytan/gstack/security/advisories/new>

Include what you can: the affected file, skill, or command; the gstack
version (`cat VERSION` in your install, or the `/gstack-upgrade` output);
steps to reproduce; and the impact you observed.

**If that link does not work:** open a minimal public issue titled
"Request for a private security contact". Do not include any technical
details, affected files, or proof of concept in it. A maintainer will reply
with a private channel, and you can send the details there.

## Scope

gstack is a set of skills, scripts, and helper binaries that run on your own
machine with your own credentials. Reports about the code in this repository
are in scope: the skill templates and generated `SKILL.md` files, `bin/`,
`lib/`, `browse/`, `scripts/`, the installer (`setup`), and the GitHub Actions
workflows. Vulnerabilities in third-party tools gstack drives (Claude Code,
Codex, gbrain, scanners, browsers) should go to those projects.

## Supported versions

Fixes land on `main` and ship in the next release. Run `/gstack-upgrade` to
get them; older versions are not patched separately.
