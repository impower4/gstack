#!/usr/bin/env python3
"""Read-only verification of brain-sync's post-add index; never repairs it."""
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import unicodedata


class Refusal(Exception):
    def __init__(self, message, spellings=()):
        super().__init__(message)
        self.spellings = spellings


def git(root, *args, data=None, allow_missing=False):
    try:
        result = subprocess.run(
            ['git', '-C', str(root), *args], input=data,
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=30)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise Refusal('index verification could not read Git') from error
    if result.returncode == 1 and allow_missing:
        return b''
    if result.returncode:
        raise Refusal('index verification Git command failed')
    return result.stdout


def prefixes(paths):
    groups = {}
    for path in paths:
        parts = path.split('/')
        for i in range(1, len(parts) + 1):
            spelling = '/'.join(parts[:i])
            key = unicodedata.normalize('NFC', spelling).casefold()
            groups.setdefault(key, set()).add(spelling)
    return groups


def names(spellings):
    # Only the colliding component names, clamped to a slug's charset: skill
    # start prints them, and the artifacts repo's paths are not trusted text.
    leaves = sorted({re.sub(r'[^A-Za-z0-9._-]', '?', s.rsplit('/', 1)[-1])[:64] for s in spellings})
    return ','.join(leaves[:4])


def first_collision(groups):
    found = sorted((key.count('/'), key) for key, spellings in groups.items() if len(spellings) > 1)
    return groups[found[0][1]] if found else ()


def tree_paths(root, *args):
    return {p.decode('utf-8') for p in git(root, *args).split(b'\0') if p}


def refuse_new_collisions(root, paths, baseline='HEAD'):
    # Compare complete component prefixes: Foo/a and foo/b collide too.
    # Existing aliases are historical data; this check does not migrate them
    # or block unrelated writes, but it refuses any additional spelling.
    head = git(root, 'ls-tree', '-rz', '--name-only', baseline) if baseline else b''
    previous = prefixes(p.decode('utf-8') for p in head.split(b'\0') if p)
    groups = prefixes(paths)
    for key, spellings in sorted(groups.items(), key=lambda item: (item[0].count('/'), item[0])):
        if len(spellings) > 1 and not spellings <= previous.get(key, set()):
            raise Refusal('new casefold path collision; inspect path spellings before retrying', spellings)
    return first_collision(groups)


def hold(root, requested_file, held_file):
    # A requested path is held when one of its prefixes has another spelling
    # in the index or in this batch, unless its own spelling is the only one
    # the index already tracks (an established project keeps syncing; the new
    # alias waits). Held paths are never staged, so git cannot record them
    # under the other spelling, and their queue records stay.
    requested = {p for p in Path(requested_file).read_text(encoding='utf-8').replace('\r', '').split('\n') if p}
    tracked_paths = tree_paths(root, 'ls-files', '-z')
    tracked = prefixes(tracked_paths)
    groups = prefixes(tracked_paths | requested)
    held, colliding = set(), []
    for path in requested:
        parts = path.split('/')
        for i in range(1, len(parts) + 1):
            spelling = '/'.join(parts[:i])
            key = unicodedata.normalize('NFC', spelling).casefold()
            if len(groups[key]) > 1 and tracked.get(key) != {spelling}:
                held.add(path)
                colliding.append((key.count('/'), key))
                break
    with open(held_file, 'w', encoding='utf-8', newline='\n') as f:
        f.writelines(p + '\n' for p in sorted(held))
    return groups[min(colliding)[1]] if colliding else ()


def verify(root, requested_file, names_file):
    requested = set(Path(requested_file).read_text(encoding='utf-8').splitlines())
    requested.discard('')
    entries = {}
    for record in git(root, 'ls-files', '--stage', '-z').split(b'\0'):
        if not record:
            continue
        header, name = record.split(b'\t', 1)
        mode, oid, stage = header.split()
        name = name.decode('utf-8')
        if stage != b'0':
            raise Refusal('unmerged index entries; inspect the index')
        entries[name] = (mode, oid)
    changed = {p.decode('utf-8') for p in Path(names_file).read_bytes().split(b'\0') if p}
    refuse_new_collisions(root, set(entries) | requested)
    if requested - entries.keys() or changed - requested:
        raise Refusal('requested/index path mismatch; inspect exact path spellings and unrelated staged entries')

    regular = []
    for name in sorted(requested):
        mode, oid = entries[name]
        file = root / name
        actual = file.lstat().st_mode
        if mode == b'120000' and stat.S_ISLNK(actual):
            hashed = git(root, 'hash-object', '--stdin', data=os.fsencode(os.readlink(file))).strip()
            if hashed != oid:
                raise Refusal('requested/index content mismatch')
        elif mode in (b'100644', b'100755') and stat.S_ISREG(actual):
            regular.append(name)
        else:
            raise Refusal('requested/index file type mismatch')
    if regular:
        # --stdin-paths applies the same clean filters/EOL conversion as add.
        # Quote each path as Git's C-style input (including quotes/backslashes).
        paths = ''.join(json.dumps(p, ensure_ascii=False) + '\n' for p in regular).encode('utf-8')
        hashes = git(root, 'hash-object', '--stdin-paths', data=paths).splitlines()
        if len(hashes) != len(regular) or any(entries[p][1] != oid for p, oid in zip(regular, hashes)):
            raise Refusal('requested/index content mismatch; queued content is not in the index')


def outgoing(root):
    if not git(root, 'rev-parse', '--verify', '--quiet', 'HEAD', allow_missing=True):
        return ()
    branch = git(root, 'rev-parse', '--abbrev-ref', 'HEAD').decode('utf-8').strip()
    remote = 'refs/remotes/origin/' + branch
    baseline = remote if git(root, 'rev-parse', '--verify', '--quiet', remote, allow_missing=True) else None
    return refuse_new_collisions(root, tree_paths(root, 'ls-tree', '-rz', '--name-only', 'HEAD'), baseline)


if __name__ == '__main__':
    try:
        if sys.argv[1] == '--outgoing':
            print(names(outgoing(Path(sys.argv[2]))))
        elif sys.argv[1] == '--hold':
            print(names(hold(Path(sys.argv[2]), sys.argv[3], sys.argv[4])))
        else:
            verify(Path(sys.argv[1]), sys.argv[2], sys.argv[3])
    except (Refusal, OSError, UnicodeError, ValueError, IndexError) as error:
        print(names(getattr(error, 'spellings', ())))
        print('BRAIN_SYNC: staged artifact validation refused: ' + str(error), file=sys.stderr)
        sys.exit(1)
