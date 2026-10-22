#Requires -Version 5.1
<#
.SYNOPSIS
    Windows entry point for gstack's ./setup.

.DESCRIPTION
    Checks that Git for Windows, Bun and Node.js are on PATH, then runs ./setup
    from this directory in Git Bash. Every argument goes to ./setup unchanged,
    as separate arguments; none is pasted into shell source.

        .\setup.ps1
        .\setup.ps1 --host codex

    Set GSTACK_GIT_BASH to a bash.exe to use instead of Git for Windows' own
    (GSTACK_BASH is its deprecated alias).
#>
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$missing = @(
    @{ Cmd = 'git';  Name = 'Git for Windows'; Id = 'Git.Git' },
    @{ Cmd = 'bun';  Name = 'Bun';             Id = 'Oven-sh.Bun' },
    @{ Cmd = 'node'; Name = 'Node.js';         Id = 'OpenJS.NodeJS.LTS' }
) | Where-Object { -not (Get-Command $_.Cmd -CommandType Application -ErrorAction SilentlyContinue) }
if ($missing) {
    Write-Host 'gstack setup needs these on PATH first:'
    foreach ($tool in $missing) { Write-Host ('  {0}: winget install --id {1} -e' -f $tool.Name, $tool.Id) }
    Write-Host 'Install them, open a new PowerShell window and run .\setup.ps1 again. Nothing was installed or changed.'
    exit 1
}

# Git Bash. The override first: GSTACK_GIT_BASH, or GSTACK_BASH, its deprecated
# alias at the same precedence (GSTACK_GIT_BASH wins when both are set and
# differ, with one warning); an override that does not exist is refused, never
# skipped. Then the Git for Windows install git.exe belongs to (git --exec-path
# finds it behind a scoop shim or in a portable Git; then the folders around
# git.exe), the per-user and machine-wide installs, and last a bash on PATH that
# reports MSYS. Never WSL's bash (System32, WindowsApps): a different
# filesystem and home. Same order and refusal as lib/script-invocation.ts.
$recipe = @(
    'Install Git for Windows (winget install --id Git.Git -e), or point gstack at its bash.exe:',
    '  PowerShell (new windows; restart Claude Code after): [Environment]::SetEnvironmentVariable(''GSTACK_GIT_BASH'', ''C:\Program Files\Git\bin\bash.exe'', ''User'')',
    '  Claude Code: add "GSTACK_GIT_BASH": "C:\\Program Files\\Git\\bin\\bash.exe" to the "env" block of ~/.claude/settings.json',
    'Nothing was installed or changed. (BASH_UNAVAILABLE; https://github.com/garrytan/gstack/blob/main/docs/troubleshooting.md#bash-unavailable)'
)
$overrideName = 'GSTACK_GIT_BASH'
$override = $env:GSTACK_GIT_BASH
if (-not $override -and $env:GSTACK_BASH) {
    $overrideName = 'GSTACK_BASH'
    $override = $env:GSTACK_BASH
} elseif ($override -and $env:GSTACK_BASH -and ($env:GSTACK_BASH -replace '\\', '/') -ne ($override -replace '\\', '/')) {
    Write-Host ('setup.ps1: GSTACK_GIT_BASH ({0}) and GSTACK_BASH ({1}) differ; using GSTACK_GIT_BASH. GSTACK_BASH is a deprecated alias: unset it.' -f $override, $env:GSTACK_BASH)
}
$bash = $null
if ($override) {
    if (-not (Test-Path -LiteralPath $override -PathType Leaf)) {
        Write-Host ('setup.ps1: {0} names {1}, which does not exist.' -f $overrideName, $override)
        foreach ($line in $recipe) { Write-Host $line }
        exit 1
    }
    $bash = $override
} else {
    $candidates = New-Object System.Collections.Generic.List[string]
    $execPath = $null
    try { $execPath = (& git --exec-path 2>$null | Select-Object -First 1) } catch { }
    if ($execPath) {
        $candidates.Add((Join-Path $execPath '..\..\..\bin\bash.exe'))
        $candidates.Add((Join-Path $execPath '..\..\..\usr\bin\bash.exe'))
    }
    $dir = Split-Path (Get-Command git -CommandType Application | Select-Object -First 1).Source
    for ($i = 0; $i -lt 3 -and $dir; $i++) {
        $candidates.Add((Join-Path $dir 'bin\bash.exe'))
        $dir = Split-Path $dir
    }
    if ($env:LOCALAPPDATA) { $candidates.Add((Join-Path $env:LOCALAPPDATA 'Programs\Git\bin\bash.exe')) }
    if ($env:ProgramFiles) { $candidates.Add((Join-Path $env:ProgramFiles 'Git\bin\bash.exe')) }
    $rejected = New-Object System.Collections.Generic.List[string]
    foreach ($candidate in $candidates) {
        $full = [System.IO.Path]::GetFullPath($candidate)
        if (Test-Path -LiteralPath $full -PathType Leaf) { $bash = $full; break }
        $rejected.Add(('  {0}: not found' -f $full))
    }
    if (-not $bash) {
        $wsl = @()
        if ($env:SystemRoot) { $wsl += ((Join-Path $env:SystemRoot 'System32') -replace '\\', '/').ToLowerInvariant() + '/' }
        foreach ($cmd in @(Get-Command bash -CommandType Application -All -ErrorAction SilentlyContinue)) {
            $path = $cmd.Source
            $norm = ($path -replace '\\', '/').ToLowerInvariant()
            if ($norm -like '*/windowsapps/*' -or ($wsl | Where-Object { $norm.StartsWith($_) })) {
                $rejected.Add(('  {0}: WSL''s bash, not Git Bash' -f $path))
                continue
            }
            $kernel = ''
            try { $kernel = [string](& $path -c 'uname -s' 2>$null | Select-Object -First 1) } catch { }
            if ($kernel -match '^(MINGW|MSYS)') { $bash = $path; break }
            $rejected.Add(('  {0}: not Git Bash (uname -s printed ''{1}'')' -f $path, $kernel))
        }
    }
    if (-not $bash) {
        Write-Host 'setup.ps1: Git Bash (bash.exe) was not found. Tried:'
        foreach ($line in $rejected) { Write-Host $line }
        foreach ($line in $recipe) { Write-Host $line }
        exit 1
    }
}

# Arguments travel NUL-separated in a private file, never on the native command
# line: PowerShell's native-argument quoting splits or merges arguments that
# contain double quotes, so bash reads them back as an exact array instead.
# The bash -c script itself holds no double quote either: Windows PowerShell
# 5.1 passes native arguments the legacy way and strips them (#3130). It reads
# the array with IFS empty and globbing off, which drops an empty argument, so
# an empty argument is refused here before anything runs.
for ($i = 0; $i -lt $args.Count; $i++) {
    if ([string]$args[$i] -eq '') {
        Write-Host ('setup.ps1: argument {0} is empty; setup takes no empty arguments. Nothing was installed or changed. (SETUP_PS1_EMPTY_ARGUMENT; https://github.com/garrytan/gstack/blob/main/docs/troubleshooting.md#setup-ps1-empty-argument)' -f ($i + 1))
        exit 2
    }
}
$argFile = [System.IO.Path]::GetTempFileName()
$writer = New-Object System.IO.StreamWriter($argFile, $false, (New-Object System.Text.UTF8Encoding($false)))
try {
    foreach ($arg in $args) { $writer.Write([string]$arg); $writer.Write([char]0) }
} finally {
    $writer.Close()
}
Push-Location -LiteralPath $PSScriptRoot
try {
    & $bash -c 'set -f; IFS=; mapfile -d '''' -t argv < $1; rm -f -- $1; exec ./setup ${argv[@]}' setup $argFile
    $code = $LASTEXITCODE
} finally {
    Pop-Location
    Remove-Item -LiteralPath $argFile -Force -ErrorAction SilentlyContinue
}
exit $code
