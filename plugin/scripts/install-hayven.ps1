<#
.SYNOPSIS
    Download + install the platform-correct `hayven` (and `hayven-native`)
    binaries from a Hayvenhurst GitHub Release. Native PowerShell port of
    install-hayven.sh.

.DESCRIPTION
    WHY this exists: the Claude Code plugin is git-based, so installing the
    plugin only clones the repo's text files (the Agent Skill). It does NOT
    deliver the compiled `hayven` CLI / `hayven-native` binary - those are
    platform-specific and large, and are deliberately NOT committed to git.
    This script is the bridge: detect the platform, map to the matching
    release tarball asset (mirroring .github/workflows/release.yml's platform
    matrix), download it, verify its sha256 and its Sigstore signature, and
    install the binaries into a known location.

    WHY a .ps1 next to the .sh: install-hayven.sh is POSIX sh and needs a
    POSIX shell. A stock Windows box - and a Claude Code agent running in a
    PowerShell-only session - may have no Git Bash at all. The Windows tarball
    (hayvenhurst-<VER>-windows-x64.tar.gz) has always shipped; only the
    installer could not run. This file is a faithful port of install-hayven.sh:
    same flags, same ordering, same security posture. Keep the two in sync.
    (It is modelled on Sirius Forester's install-sirius.ps1, which solved the
    same Windows traps first.)

    SECURITY: the `<tarball>.sha256` is served from the same origin as the
    tarball, so on its own it only catches a corrupted download, not a tampered
    release: anyone who can replace the tarball can replace its checksum too.
    Authenticity comes from the Sigstore bundle (`<tarball>.sigstore.json`),
    whose Fulcio certificate binds the artifact to THIS repo's release
    workflow. We pin both the signer identity and the OIDC issuer; otherwise an
    attacker could sign a malicious tarball with their own identity and it
    would still "verify".

    A bad signature ALWAYS aborts. A MISSING bundle ALWAYS aborts: the tarball
    came from the same origin and every release since v0.0.6 publishes a
    bundle, so "tarball but no bundle" is a signature-stripping downgrade, not
    a benign 404. (v0.0.5 and older predate signing; install those by hand.)

    The one soft case is a box with no verifier installed (`cosign` or
    `sigstore`): we cannot check, so we warn loudly and continue on TLS plus
    the checksum. An attacker cannot induce that state remotely (it depends on
    what is installed locally). Pass -RequireSignature (or set
    HAYVEN_REQUIRE_SIGNATURE=1) to make it fatal too.

    NOTE: the trust anchor follows HAYVEN_REPO. Overriding it points both the
    download AND the expected signer at that repo, so verification then only
    proves "that repo signed its own artifact". Do not set it to a repo you do
    not trust.

    Ctrl-C stops the run: PowerShell does not route a pipeline stop through
    script `catch` blocks, and the `finally` around the install removes the
    temp dir. As a backstop, every catch that turns an error into a fallback
    re-throws a stop/cancel exception first (see Assert-NotStopping).

    Idempotent + safe to re-run.

.PARAMETER Version
    Install a specific release tag (e.g. v0.0.7). Also HAYVEN_RELEASE_TAG.
    A bare "0.0.7" is accepted and normalised to "v0.0.7".

.PARAMETER Prefix
    Install into <Prefix>\bin. Also HAYVEN_INSTALL_PREFIX. Default chain:
    HAYVEN_INSTALL_PREFIX > CLAUDE_PLUGIN_DATA > $env:USERPROFILE\.local.

.PARAMETER Check
    Print status only; never downloads and never changes anything (-AddToPath
    is ignored with -Check). Exits 0 if `hayven` is on PATH or already
    installed in the prefix, 3 if missing.

.PARAMETER RequireSignature
    Abort unless the Sigstore signature actually verifies - i.e. make a
    MISSING verifier fatal too. Also HAYVEN_REQUIRE_SIGNATURE=1.
    (A BAD signature and a MISSING bundle are fatal regardless.)

.PARAMETER AddToPath
    When the install dir is not on the user PATH, append it to the user Path
    in HKCU\Environment (keeping the value's REG_EXPAND_SZ kind, so %VARS% in
    it stay live) and broadcast the change. Without this switch the exact
    command is printed instead and nothing is changed.

.PARAMETER Force
    Reinstall even when the requested version is already installed (both
    hayven.exe and hayven-native.exe report it).

.PARAMETER DryRun
    Print what would be downloaded/installed and exit, without network I/O.
    Same as HAYVEN_INSTALL_DRY_RUN=1, and the same effect as -WhatIf.

.EXAMPLE
    .\install-hayven.ps1
    Download + install the latest release.

.EXAMPLE
    .\install-hayven.ps1 -Check
    Report what is installed; change nothing.

.EXAMPLE
    .\install-hayven.ps1 -Version v0.0.7 -RequireSignature -AddToPath
    Install a pinned tag, refuse to proceed unverified, and fix PATH.

.NOTES
    Environment:
      HAYVEN_INSTALL_PREFIX      override the install prefix (same as -Prefix)
      HAYVEN_RELEASE_TAG         pin a release tag (same as -Version)
      HAYVEN_REPO                override owner/repo (default Davidb3l/Hayvenhurst-dev)
      HAYVEN_REQUIRE_SIGNATURE=1 same as -RequireSignature
      HAYVEN_INSTALL_DRY_RUN=1   same as -DryRun
      CLAUDE_PLUGIN_DATA         plugin-managed data dir (default prefix when set)

    Windows PowerShell 5.1 compatible, pure ASCII (5.1 reads a BOM-less file
    in the ANSI code page). Exit codes: 0 ok / already installed, 1 error
    (PowerShell's own parameter-binding errors also exit 1 under -File),
    3 (-Check) not installed.
#>

[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$Version,
    [string]$Prefix,
    [switch]$Check,
    [switch]$RequireSignature,
    [switch]$AddToPath,
    [switch]$Force,
    [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
# Invoke-WebRequest's progress bar makes downloads an order of magnitude slower
# in Windows PowerShell 5.1.
$ProgressPreference = 'SilentlyContinue'

# ---- configuration ----------------------------------------------------------

$Repo = $env:HAYVEN_REPO
if ([string]::IsNullOrEmpty($Repo)) { $Repo = 'Davidb3l/Hayvenhurst-dev' }

$Tag = $Version
if ([string]::IsNullOrEmpty($Tag)) { $Tag = $env:HAYVEN_RELEASE_TAG }

# Default install prefix: ${CLAUDE_PLUGIN_DATA} when invoked by the plugin
# (persists across plugin updates), else ~\.local. We install binaries into
# <prefix>\bin.
if ([string]::IsNullOrEmpty($Prefix)) { $Prefix = $env:HAYVEN_INSTALL_PREFIX }
if ([string]::IsNullOrEmpty($Prefix)) { $Prefix = $env:CLAUDE_PLUGIN_DATA }
if ([string]::IsNullOrEmpty($Prefix)) {
    $homeDir = $env:USERPROFILE
    if ([string]::IsNullOrEmpty($homeDir)) { $homeDir = $HOME }
    if ([string]::IsNullOrEmpty($homeDir)) {
        # Mirrors install-hayven.sh's "no defensible install location" stance:
        # say so rather than silently installing into \.local\bin.
        [Console]::Error.WriteLine('install-hayven: error: cannot determine a home directory. Pass -Prefix <dir> or set HAYVEN_INSTALL_PREFIX.')
        exit 1
    }
    $Prefix = Join-Path $homeDir '.local'
}
# A relative -Prefix would install fine and then write a RELATIVE directory into
# the user Path (-AddToPath), which resolves against whatever directory each
# future process starts in. Anchor it to the current location once, here.
$Prefix = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Prefix)

$BinDir     = Join-Path $Prefix 'bin'
$BinName    = 'hayven.exe'
$NativeName = 'hayven-native.exe'
$BinPath    = Join-Path $BinDir $BinName

# Make a missing verifier fatal. A BAD signature is fatal regardless.
$RequireSig = [bool]$RequireSignature
if ($env:HAYVEN_REQUIRE_SIGNATURE -eq '1') { $RequireSig = $true }

# -WhatIf is treated as the dry run: cheap, and it keeps `-WhatIf` from being a
# lie (nothing this script does is undoable-by-preview otherwise).
$IsDryRun = [bool]$DryRun
if ($env:HAYVEN_INSTALL_DRY_RUN -eq '1') { $IsDryRun = $true }
if ($WhatIfPreference) { $IsDryRun = $true }
# Having read it, switch -WhatIf OFF for the rest of the script. Left on, it
# turns every Start-Process / Remove-Item inside Invoke-Native into a "What if:"
# no-op too: the version probe would silently "fail" and temp files would leak.
# The dry-run path above is what honors it.
$WhatIfPreference = $false

# -Check promises to change nothing, so it never edits PATH even with -AddToPath.
$MayEditPath = [bool]$AddToPath -and -not [bool]$Check

$CertIssuer = 'https://token.actions.githubusercontent.com'

# ---- tiny helpers -----------------------------------------------------------

# install-hayven.sh logs to stderr so stdout stays clean for callers; mirror it.
function Write-Log {
    param([string]$Message = '')
    [Console]::Error.WriteLine($Message)
}

function Stop-WithError {
    param([string]$Message)
    Write-Log ('install-hayven: error: ' + $Message)
    exit 1
}

# Several catches below deliberately turn an error into a fallback ("API
# failed, try the redirect"; "this python can't import sigstore, try the next
# one"). PowerShell normally does not deliver Ctrl-C (a pipeline stop) to a
# script `catch` at all, so this is a BACKSTOP, not the mechanism: if a stop or
# a cancellation ever does arrive as a catchable exception (a .NET API wrapping
# OperationCanceledException, a host that surfaces it differently), re-throw it
# rather than treating it as "that probe failed, carry on".
function Assert-NotStopping {
    param($ErrorRecord)
    $ex = $null
    if ($null -ne $ErrorRecord) { $ex = $ErrorRecord.Exception }
    while ($null -ne $ex) {
        if ($ex -is [System.Management.Automation.PipelineStoppedException] -or
            $ex -is [System.OperationCanceledException]) {
            throw $ErrorRecord
        }
        $ex = $ex.InnerException
    }
}

# `command -v <x> >/dev/null 2>&1`
function Test-HaveCommand {
    param([string]$Name)
    $c = Get-Command $Name -ErrorAction SilentlyContinue
    return ($null -ne $c)
}

function Get-CommandPath {
    param([string]$Name)
    $c = Get-Command $Name -ErrorAction SilentlyContinue
    if ($null -eq $c) { return $null }
    if ($c.PSObject.Properties.Name -contains 'Source' -and -not [string]::IsNullOrEmpty($c.Source)) { return $c.Source }
    return $c.Name
}

# The path of something Start-Process can actually launch. A plain Get-Command
# prefers PowerShell's own command types, so for a tool installed through npm it
# returns the `<tool>.ps1` shim (npm installs .ps1, .cmd AND an extensionless sh
# shim side by side). A .ps1 is not a Win32 executable: Start-Process throws on
# it and the call would be reported as failed. -CommandType Application
# restricts the lookup to real programs; the extension filter then keeps
# exactly the shapes Invoke-Native knows how to launch (.exe/.com directly,
# .cmd/.bat via cmd.exe) and drops the extensionless sh shim. $null when
# nothing launchable matches.
function Get-NativeExePath {
    param([string]$Name)
    $hits = @(Get-Command $Name -CommandType Application -All -ErrorAction SilentlyContinue)
    foreach ($h in $hits) {
        if ($null -ne $h.Path -and $h.Path -match '\.(exe|com|cmd|bat)$') { return $h.Path }
    }
    return $null
}

# Where `hayven` resolves on PATH, restricted to real programs (see
# Get-NativeExePath) so a stray hayven.ps1 or sh shim is not reported as an
# installed binary.
function Get-HayvenOnPath {
    $hits = @(Get-Command 'hayven' -CommandType Application -All -ErrorAction SilentlyContinue)
    foreach ($h in $hits) {
        if ($null -ne $h.Path -and $h.Path -match '\.(exe|com)$') { return $h.Path }
    }
    return $null
}

# False when the resolved command is a Windows "App Execution Alias" stub: a
# 0-byte reparse point that launches the Microsoft Store instead of a program.
function Test-SafeToProbe {
    param([string]$Name)
    $p = Get-CommandPath $Name
    if ($null -eq $p) { return $false }
    try {
        $item = Get-Item -LiteralPath $p -Force -ErrorAction Stop
    } catch {
        Assert-NotStopping $_
        return $true   # can't tell; let the probe decide
    }
    if ($item.PSObject.Properties.Name -contains 'Length' -and $item.Length -eq 0 -and
        ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
        return $false
    }
    return $true
}

# Windows command-line quoting. Start-Process -ArgumentList joins with plain
# spaces in 5.1, which silently breaks any path containing a space (temp dirs
# under a spaced user name, a prefix under "Program Files"). Quote every
# argument ourselves.
function Format-NativeArg {
    param([string]$Value)
    if ($null -eq $Value) { return '""' }
    if ($Value -eq '') { return '""' }
    if ($Value -notmatch '[\s"]') { return $Value }
    # Double any backslash run that immediately precedes a quote, then escape
    # the quote; finally double a trailing backslash run (it would otherwise
    # escape our closing quote).
    $escaped = $Value -replace '(\\*)"', '$1$1\"'
    $escaped = $escaped -replace '(\\*)$', '$1$1'
    return '"' + $escaped + '"'
}

# Run a native program and capture its output WITHOUT `2>&1`. In Windows
# PowerShell 5.1 redirecting a native command's stderr inside the pipeline
# wraps each line in a NativeCommandError and poisons $? / $ErrorActionPreference
# = 'Stop'. Start-Process with real redirect files sidesteps all of it.
function Invoke-Native {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [string[]]$ArgumentList = @()
    )

    $exe = Get-NativeExePath $FilePath
    if ($null -eq $exe) { $exe = $FilePath }

    $quoted = @()
    foreach ($a in $ArgumentList) { $quoted += (Format-NativeArg $a) }

    # A .cmd/.bat shim cannot be launched with UseShellExecute=false, which is
    # what -NoNewWindow implies. Go via cmd.exe. The extra outer quotes are
    # cmd's documented /c rule: when the string after /c starts with a quote and
    # holds more than one, cmd strips the outermost pair - which is what keeps a
    # spaced program path intact.
    if ($exe -match '\.(cmd|bat)$') {
        $inner = @((Format-NativeArg $exe)) + $quoted
        $argString = '/c "' + ($inner -join ' ') + '"'
        $exe = 'cmd.exe'
    } else {
        $argString = ($quoted -join ' ')
    }

    $outFile = [System.IO.Path]::GetTempFileName()
    $errFile = [System.IO.Path]::GetTempFileName()

    try {
        $sp = @{
            FilePath               = $exe
            NoNewWindow            = $true
            Wait                   = $true
            PassThru               = $true
            RedirectStandardOutput = $outFile
            RedirectStandardError  = $errFile
        }
        if (-not [string]::IsNullOrEmpty($argString)) { $sp['ArgumentList'] = $argString }

        $proc = Start-Process @sp
        $stdout = ''
        $stderr = ''
        if (Test-Path -LiteralPath $outFile) { $stdout = (Get-Content -LiteralPath $outFile -Raw -ErrorAction SilentlyContinue) }
        if (Test-Path -LiteralPath $errFile) { $stderr = (Get-Content -LiteralPath $errFile -Raw -ErrorAction SilentlyContinue) }
        if ($null -eq $stdout) { $stdout = '' }
        if ($null -eq $stderr) { $stderr = '' }

        return [pscustomobject]@{
            ExitCode = $proc.ExitCode
            Output   = ($stdout + $stderr).Trim()
        }
    } catch {
        Assert-NotStopping $_
        return [pscustomobject]@{
            ExitCode = -1
            Output   = $_.Exception.Message
        }
    } finally {
        foreach ($f in @($outFile, $errFile)) {
            if ($null -ne $f) { Remove-Item -LiteralPath $f -Force -ErrorAction SilentlyContinue }
        }
    }
}

# Windows PowerShell 5.1 negotiates SSL3/TLS1.0 by default on some boxes;
# github.com and the API both require TLS 1.2+.
function Enable-Tls12 {
    try {
        [Net.ServicePointManager]::SecurityProtocol = `
            [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    } catch {
        Assert-NotStopping $_
        # Nothing sane to do; the request below will report the real failure.
    }
}

$UserAgent = 'install-hayven.ps1 (+https://github.com/Davidb3l/Hayvenhurst-dev)'

function Get-RemoteFile {
    param(
        [Parameter(Mandatory = $true)][string]$Uri,
        [Parameter(Mandatory = $true)][string]$OutFile
    )
    Enable-Tls12
    Invoke-WebRequest -Uri $Uri -OutFile $OutFile -UseBasicParsing -UserAgent $UserAgent -ErrorAction Stop | Out-Null
}

function Get-RemoteString {
    param([Parameter(Mandatory = $true)][string]$Uri)
    Enable-Tls12
    $resp = Invoke-WebRequest -Uri $Uri -UseBasicParsing -UserAgent $UserAgent -ErrorAction Stop
    $content = $resp.Content
    if ($null -eq $content) { return '' }
    # GitHub serves release assets (our `.sha256` included) as
    # application/octet-stream, and for a non-text content type Invoke-WebRequest
    # hands back .Content as a byte[] (5.1 and 7+ alike). A plain [string] cast
    # of that array yields "48 54 49 ..." - the decimal byte values joined by
    # spaces - so every checksum would "fail" as not-a-hex-digest. Decode the
    # bytes instead. The checksum file is ASCII hex, so UTF-8 is exact; strip a
    # BOM in case one was ever written. The hex-digest check in the caller still
    # runs on the result, so anything odd here fails closed, never open.
    if ($content -is [byte[]]) {
        $text = [System.Text.Encoding]::UTF8.GetString($content)
        return $text.TrimStart([char]0xFEFF)
    }
    return [string]$content
}

# ---- suite awareness --------------------------------------------------------
# Hayvenhurst is the code graph of a four-tool suite: Ametrite holds the task
# board, Sirius Forester runs the foreman loop, Catryna Wikinelli keeps the
# living docs. One short nudge, only when something is missing.
#
# Test-SuiteRepo: true when the cwd already uses any suite tool. The nudge stays
# quiet outside suite repos so it never nags unrelated projects.

$UserHome = $env:USERPROFILE
if ([string]::IsNullOrEmpty($UserHome)) { $UserHome = $HOME }

$ClaudePluginsDir = $env:CLAUDE_PLUGINS_DIR
if ([string]::IsNullOrEmpty($ClaudePluginsDir)) {
    $h = $UserHome
    if ([string]::IsNullOrEmpty($h)) { $h = '.' }
    $ClaudePluginsDir = Join-Path (Join-Path $h '.claude') 'plugins'
}

function Test-FileContains {
    param([string]$Path, [string]$Needle)
    if ([string]::IsNullOrEmpty($Path)) { return $false }
    if (-not (Test-Path -LiteralPath $Path)) { return $false }
    try {
        $text = Get-Content -LiteralPath $Path -Raw -ErrorAction Stop
    } catch {
        Assert-NotStopping $_
        return $false
    }
    if ($null -eq $text) { return $false }
    return $text.Contains($Needle)
}

function Test-SuiteRepo {
    # HOME IS NEVER A SUITE REPO. ~\.hayven is the GLOBAL config dir (registry,
    # writer id, logs), so a bare "does .hayven exist here" answers "yes, a
    # project" whenever this runs from the home dir. That exact conflation is
    # what once let a daemon index a user's entire home tree; install-hayven.sh
    # carries the same guard.
    if (-not [string]::IsNullOrEmpty($UserHome) -and (Test-Path -LiteralPath $UserHome)) {
        try {
            $here = [System.IO.Path]::GetFullPath((Get-Location -PSProvider FileSystem).ProviderPath).TrimEnd('\', '/')
            $homeFull = [System.IO.Path]::GetFullPath($UserHome).TrimEnd('\', '/')
            if ([string]::Equals($here, $homeFull, [System.StringComparison]::OrdinalIgnoreCase)) { return $false }
        } catch {
            Assert-NotStopping $_
        }
    }
    # .docs\ alone is too generic a name; require Catryna's index file.
    if (Test-Path -LiteralPath '.sirius')   { return $true }
    if (Test-Path -LiteralPath '.ametrite') { return $true }
    if (Test-Path -LiteralPath '.hayven')   { return $true }
    if (Test-Path -LiteralPath (Join-Path '.docs' '_index.json')) { return $true }
    return $false
}

function Write-SuiteHint {
    $missing = @()
    if (-not (Test-HaveCommand 'amt'))    { $missing += 'Ametrite' }
    if (-not (Test-HaveCommand 'sirius')) { $missing += 'Sirius' }
    # Prefix match: catryna installs as `catryna@<marketplace>` and there are
    # two legitimate marketplaces (its own `catryna-wikinelli`, and the Sothis
    # bundle `sirius-forester`). Pinning one key nags the other's users forever.
    if (-not (Test-FileContains (Join-Path $ClaudePluginsDir 'installed_plugins.json') '"catryna@')) {
        $missing += 'Catryna'
    }
    if ($missing.Count -eq 0) { return }

    Write-Log ''
    Write-Log ('fleet suite: missing: ' + ($missing -join ' ') + '. Hayvenhurst is the suite''s code graph; for full fleet control install the whole suite:')
    if ($missing -contains 'Sirius')   { Write-Log '  Sirius Forester (fleet foreman): /plugin marketplace add Davidb3l/Sirius-Forester, /plugin install sirius@sirius-forester, then /sirius:install-binary' }
    if ($missing -contains 'Catryna')  { Write-Log '  Catryna Wikinelli (code wiki): /plugin marketplace add Davidb3l/Catryna-Wikinelli, then /plugin install catryna@catryna-wikinelli (Sothis bundle users: /plugin install catryna@sirius-forester)' }
    if ($missing -contains 'Ametrite') { Write-Log '  Ametrite (task board): ask Claude to "ametrite this repo" (the skill bootstraps the amt CLI)' }
}

# ---- platform detection -> release asset name -------------------------------
# Mirrors the matrix in .github/workflows/release.yml:
#   linux-x64-glibc  linux-arm64  macos-x64  macos-arm64  windows-x64
# Tarball asset name: hayvenhurst-<version>-<platform>.tar.gz
#   (version = tag with the leading "v" stripped)
#
# This file covers the windows-x64 slot. PowerShell 7 also runs on Linux and
# macOS, but those platforms already have install-hayven.sh (which handles
# their shells, their PATH files and their arch split), so point there rather
# than maintaining a second, weaker copy of that logic.
function Get-Platform {
    $onWindows = $true
    $v = Get-Variable -Name 'IsWindows' -ErrorAction SilentlyContinue
    if ($null -ne $v) { $onWindows = [bool]$v.Value }  # PowerShell 6+ only
    if (-not $onWindows) {
        Stop-WithError 'this PowerShell is not running on Windows. Use install-hayven.sh (the POSIX installer) on macOS and Linux.'
    }

    $arch = $env:PROCESSOR_ARCHITECTURE
    if ([string]::IsNullOrEmpty($arch)) { $arch = 'AMD64' }
    switch ($arch.ToUpperInvariant()) {
        'AMD64' { return 'windows-x64' }
        'X86'   {
            # A 32-bit PowerShell on 64-bit Windows: PROCESSOR_ARCHITEW6432
            # still reports the real machine.
            $native = $env:PROCESSOR_ARCHITEW6432
            if (-not [string]::IsNullOrEmpty($native)) { return 'windows-x64' }
            Stop-WithError 'unsupported CPU arch ''x86'' (the release matrix publishes windows-x64 only)'
        }
        'ARM64' {
            # There is no windows-arm64 release target; Windows on ARM runs the
            # x64 build under emulation. Say so rather than failing outright.
            Write-Log 'install-hayven: note: no windows-arm64 release exists; using the windows-x64 build (runs under Windows'' x64 emulation).'
            return 'windows-x64'
        }
    }
    Stop-WithError ('unsupported CPU arch ''' + $arch + '''')
}

# Resolve "latest" to a concrete tag. Primary: the public GitHub API. Fallback:
# the /releases/latest redirect, which needs no token and survives a rate-limited
# API.
function Resolve-LatestTag {
    if (-not [string]::IsNullOrEmpty($Tag)) { return $Tag }

    $resolved = $null
    Enable-Tls12
    try {
        $rel = Invoke-RestMethod -Uri ('https://api.github.com/repos/' + $Repo + '/releases/latest') `
            -UseBasicParsing -UserAgent $UserAgent -ErrorAction Stop
        if ($null -ne $rel -and $rel.PSObject.Properties.Name -contains 'tag_name') {
            $resolved = [string]$rel.tag_name
        }
    } catch {
        Assert-NotStopping $_
        $resolved = $null
    }

    if ([string]::IsNullOrEmpty($resolved)) {
        try {
            $resp = Invoke-WebRequest -Uri ('https://github.com/' + $Repo + '/releases/latest') `
                -UseBasicParsing -UserAgent $UserAgent -ErrorAction Stop
            $final = ''
            $base = $resp.BaseResponse
            if ($null -ne $base) {
                if ($base.PSObject.Properties.Name -contains 'ResponseUri' -and $null -ne $base.ResponseUri) {
                    $final = [string]$base.ResponseUri.AbsoluteUri          # 5.1
                } elseif ($base.PSObject.Properties.Name -contains 'RequestMessage' -and $null -ne $base.RequestMessage) {
                    $final = [string]$base.RequestMessage.RequestUri.AbsoluteUri  # 7+
                }
            }
            if ($final -match '/releases/tag/(.+)$') { $resolved = $Matches[1] }
        } catch {
            Assert-NotStopping $_
            $resolved = $null
        }
    }

    if ([string]::IsNullOrEmpty($resolved)) {
        Stop-WithError ('could not resolve the latest release tag for ' + $Repo + ' (pass -Version vX.Y.Z)')
    }
    return $resolved
}

# ---- PATH -------------------------------------------------------------------

# Two PATHs matter and they disagree constantly on Windows: the CURRENT
# process's copy (inherited at launch) and the persisted USER value (what new
# shells will get). "Already added, just stale here" is a different message
# from "never added", so answer them separately.
function Test-DirInPathString {
    param([string]$PathValue, [string]$Dir)
    if ([string]::IsNullOrEmpty($PathValue)) { return $false }
    $needle = $Dir.TrimEnd('\', '/')
    foreach ($entry in $PathValue.Split(';')) {
        if ([string]::IsNullOrEmpty($entry)) { continue }
        if ($entry.Trim().Trim('"').TrimEnd('\', '/') -eq $needle) { return $true }
    }
    return $false
}

function Test-DirOnProcessPath {
    param([string]$Dir)
    return (Test-DirInPathString -PathValue $env:PATH -Dir $Dir)
}

function Test-DirOnUserPath {
    param([string]$Dir)
    $raw = [Environment]::GetEnvironmentVariable('Path', 'User')
    if (Test-DirInPathString -PathValue $raw -Dir $Dir) { return $true }
    return (Test-DirInPathString -PathValue ([Environment]::ExpandEnvironmentVariables([string]$raw)) -Dir $Dir)
}

# Printed for the user to paste. A raw registry write that keeps Path's
# REG_EXPAND_SZ kind (see Add-BinDirToUserPath for why the familiar
# SetEnvironmentVariable('Path', ...) one-liner must NOT be suggested).
$PathAddCommand = '$d=''' + $BinDir.Replace("'", "''") + '''; $k=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey("Environment"); $p=[string]$k.GetValue("Path","",[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames); $k.SetValue("Path",($p.TrimEnd(";")+";"+$d).TrimStart(";"),[Microsoft.Win32.RegistryValueKind]::ExpandString); $k.Close(); [Environment]::SetEnvironmentVariable("HAYVEN_PATH_BROADCAST",$null,"User")'

function Add-BinDirToUserPath {
    # Writes the USER (not machine) Path only - no elevation, no other user
    # affected.
    #
    # NOT via [Environment]::SetEnvironmentVariable('Path', ..., 'User'): that
    # API reads the value EXPANDED and writes it back as REG_SZ, which silently
    # and permanently turns a REG_EXPAND_SZ Path into a plain string - every
    # %USERPROFILE% / %LOCALAPPDATA% entry in it gets frozen to today's value.
    # So go to HKCU\Environment directly: read the RAW value (unexpanded), append,
    # and write it back with the SAME registry kind it had (ExpandString when
    # there was no Path yet, which is what Windows itself uses).
    $envKey = $null
    try {
        # CreateSubKey opens the existing key for writing (or creates it on a
        # box that somehow has none).
        $envKey = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')
    } catch {
        Assert-NotStopping $_
        $envKey = $null
    }
    if ($null -eq $envKey) {
        Write-Log 'install-hayven: WARNING: could not open HKCU\Environment to update the user PATH.'
        Write-Log 'install-hayven: WARNING: add it yourself with:'
        Write-Log ('      ' + $PathAddCommand)
        return
    }
    try {
        $current = ''
        $kind = [Microsoft.Win32.RegistryValueKind]::ExpandString
        $raw = $envKey.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
        if ($null -ne $raw) { $current = [string]$raw }
        if ($envKey.GetValueNames() -contains 'Path') { $kind = $envKey.GetValueKind('Path') }

        # Compare against the expanded form too: an entry written as
        # %USERPROFILE%\.local\bin is the same directory as our literal BinDir.
        if ((Test-DirInPathString -PathValue $current -Dir $BinDir) -or
            (Test-DirInPathString -PathValue ([Environment]::ExpandEnvironmentVariables($current)) -Dir $BinDir)) {
            Write-Log ('install-hayven: ' + $BinDir + ' is already on your user PATH.')
            return
        }
        if ($current -eq '') {
            $updated = $BinDir
        } else {
            $updated = $current.TrimEnd(';') + ';' + $BinDir
        }
        $envKey.SetValue('Path', $updated, $kind)
    } catch {
        Assert-NotStopping $_
        Write-Log ('install-hayven: WARNING: could not update the user PATH: ' + $_.Exception.Message)
        Write-Log ('install-hayven: WARNING: add it yourself with:')
        Write-Log ('      ' + $PathAddCommand)
        return
    } finally {
        $envKey.Close()
    }

    # A raw registry write does not tell anyone it happened; Explorer (and so
    # every process it launches next) keeps the old environment until it gets a
    # WM_SETTINGCHANGE "Environment" broadcast. The simplest robust way to send
    # one from 5.1 without Add-Type (a C# compile: slow, and blocked under
    # Constrained Language Mode) is to let .NET do it: SetEnvironmentVariable
    # with a User target broadcasts unconditionally after its registry write.
    # Deleting a variable that does not exist is a no-op write, so the only
    # lasting effect is the broadcast itself.
    try {
        [Environment]::SetEnvironmentVariable('HAYVEN_INSTALL_PATH_BROADCAST', $null, 'User')
    } catch {
        Assert-NotStopping $_
        # Harmless: new shells started after a logoff still see the new Path.
    }

    # Make it usable in THIS process too; the persisted value only reaches new
    # processes.
    if ([string]::IsNullOrEmpty($env:PATH)) {
        $env:PATH = $BinDir
    } else {
        $env:PATH = $env:PATH.TrimEnd(';') + ';' + $BinDir
    }
    Write-Log ('install-hayven: added ' + $BinDir + ' to your user PATH.')
}

function Write-PathHint {
    if (Test-DirOnProcessPath $BinDir) { return }
    if (Test-DirOnUserPath $BinDir) {
        Write-Log ''
        Write-Log ('note: ' + $BinDir + ' is already on your user PATH, but this shell was')
        Write-Log '      started before that took effect. Restart your shell (and Claude Code /'
        Write-Log '      the Claude desktop app) to pick it up.'
        return
    }
    Write-Log ''
    if ($MayEditPath) {
        if ($IsDryRun) {
            Write-Log ('DRY RUN: would add ' + $BinDir + ' to your user PATH')
        } else {
            Add-BinDirToUserPath
        }
    } else {
        Write-Log ('note: ' + $BinDir + ' is not on your PATH. Add it with:')
        Write-Log ('      ' + $PathAddCommand)
        Write-Log '      (or re-run this installer with -AddToPath)'
    }
    Write-Log 'note: PATH changes only reach NEW processes - restart your shell'
    Write-Log '      (and Claude Code / the Claude desktop app) to pick it up.'
}

# ---- installed-version probe ------------------------------------------------

function Get-InstalledVersion {
    param([string]$Path)
    if ([string]::IsNullOrEmpty($Path)) { return $null }
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    $r = Invoke-Native -FilePath $Path -ArgumentList @('--version')
    if ($r.ExitCode -ne 0) { return $null }
    if ($r.Output -match '(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.\-]+)?)') { return $Matches[1] }
    return $null
}

# ---- -Check: status only, never downloads -----------------------------------

if ($Check) {
    $onPath = Get-HayvenOnPath
    if ($null -ne $onPath) {
        $v = Get-InstalledVersion $onPath
        if ($null -ne $v) {
            Write-Log ('hayven: already on PATH (' + $onPath + ', version ' + $v + ')')
        } else {
            Write-Log ('hayven: already on PATH (' + $onPath + ')')
        }
        if (Test-SuiteRepo) { Write-SuiteHint }
        exit 0
    }
    if (Test-Path -LiteralPath $BinPath) {
        $v = Get-InstalledVersion $BinPath
        if ($null -ne $v) {
            Write-Log ('hayven: installed at ' + $BinPath + ' (version ' + $v + ', not on PATH)')
        } else {
            Write-Log ('hayven: installed at ' + $BinPath + ' (not on PATH)')
        }
        Write-PathHint
        if (Test-SuiteRepo) { Write-SuiteHint }
        exit 0
    }
    Write-Log 'hayven: not installed. Run /hayvenhurst:install-binary (or plugin\scripts\install-hayven.ps1) to install it.'
    if (Test-SuiteRepo) { Write-SuiteHint }
    exit 3
}

# ---- signature verification --------------------------------------------------
# Verify with whichever Sigstore verifier is on the box. Pin BOTH the signer
# identity (this repo's release.yml, at this tag) and the OIDC issuer: an
# unpinned verify only proves "somebody signed this", not "the release workflow
# signed this".
function Invoke-SignatureVerification {
    param(
        [Parameter(Mandatory = $true)][string]$Bundle,
        [Parameter(Mandatory = $true)][string]$Artifact,
        [Parameter(Mandatory = $true)][string]$AssetName,
        [Parameter(Mandatory = $true)][string]$ReleaseTag
    )

    $identity = 'https://github.com/' + $Repo + '/.github/workflows/release.yml@refs/tags/' + $ReleaseTag
    $sigFail = @"
SIGNATURE VERIFICATION FAILED for $AssetName
        expected signer: $identity
        expected issuer: $CertIssuer
        Refusing to install: this artifact was not produced by $Repo's release workflow.
"@

    # cosign older than 3.0 cannot read sigstore-python v3's `.sigstore.json`
    # bundle at all, so its failure says nothing about the artifact. Treat an
    # old cosign as NO usable cosign (fall through to `sigstore`, then to the
    # no-verifier path) instead of reporting a tampered release. No weaker than
    # not having cosign: an attacker cannot choose which cosign is installed
    # locally, and -RequireSignature still makes the end of that road fatal.
    $cosignOk = $false
    if ($null -ne (Get-NativeExePath 'cosign')) {
        $cv = Invoke-Native -FilePath 'cosign' -ArgumentList @('version')
        $major = $null
        if ($cv.Output -match 'GitVersion:\s*v?(\d+)\.') { $major = [int]$Matches[1] }
        if ($null -ne $major -and $major -lt 3) {
            Write-Log ('install-hayven: note: cosign ' + $major + '.x cannot read this bundle format (needs cosign 3+); not using it.')
        } else {
            $cosignOk = $true
        }
    }

    if ($cosignOk) {
        Write-Log 'install-hayven: verifying signature (cosign)'
        # Keep the verifier's own diagnostics: on a real identity mismatch
        # cosign prints "expected X, got Y". Swallowing it makes a toolchain
        # problem look identical to a tampered artifact.
        $r = Invoke-Native -FilePath 'cosign' -ArgumentList @(
            'verify-blob',
            '--bundle', $Bundle,
            '--certificate-identity', $identity,
            '--certificate-oidc-issuer', $CertIssuer,
            $Artifact
        )
        if ($r.ExitCode -ne 0) {
            Stop-WithError ($sigFail + "
        verifier output:
" + $r.Output)
        }
        Write-Log 'install-hayven: signature OK (cosign)'
        return
    }

    # `sigstore` as its own entry point, else any python that can import it.
    $sigExe = $null
    $sigPrefixArgs = @()
    if ($null -ne (Get-NativeExePath 'sigstore')) {
        $sigExe = 'sigstore'
    } else {
        foreach ($py in @('python3', 'python', 'py')) {
            if ($null -eq (Get-NativeExePath $py)) { continue }
            # Stock Windows puts 0-byte "App Execution Alias" reparse points for
            # python/python3 in %LOCALAPPDATA%\Microsoft\WindowsApps. Running one
            # OPENS THE MICROSOFT STORE - a GUI popping up mid-install. Skip
            # them; the worst case is falling through to the documented
            # no-verifier warning, which is safe (a bad signature still aborts).
            if (-not (Test-SafeToProbe $py)) { continue }
            $probe = Invoke-Native -FilePath $py -ArgumentList @('-c', 'import sigstore')
            if ($probe.ExitCode -eq 0) {
                $sigExe = $py
                $sigPrefixArgs = @('-m', 'sigstore')
                break
            }
        }
    }

    if ($null -ne $sigExe) {
        Write-Log 'install-hayven: verifying signature (sigstore)'
        $sigArgs = $sigPrefixArgs + @(
            'verify', 'identity',
            '--bundle', $Bundle,
            '--cert-identity', $identity,
            '--cert-oidc-issuer', $CertIssuer,
            $Artifact
        )
        $r = Invoke-Native -FilePath $sigExe -ArgumentList $sigArgs
        if ($r.ExitCode -ne 0) {
            Stop-WithError ($sigFail + "
        verifier output:
" + $r.Output)
        }
        Write-Log 'install-hayven: signature OK (sigstore)'
        return
    }

    if ($RequireSig) {
        Stop-WithError 'no signature verifier found, and -RequireSignature was set.
        Install one:  winget install Sigstore.Cosign   (or)   pip install sigstore'
    }
    Write-Log 'install-hayven: WARNING: no signature verifier (cosign / sigstore) found.'
    Write-Log 'install-hayven: WARNING: proceeding on TLS + checksum alone, which cannot'
    Write-Log 'install-hayven: WARNING: detect a tampered release. To verify provenance:'
    Write-Log 'install-hayven: WARNING:   winget install Sigstore.Cosign  (or)  pip install sigstore'
    Write-Log 'install-hayven: WARNING: then re-run with -RequireSignature.'
}

# Copy one staged file into BinDir. Atomic-ish: write then move into place. A
# running hayven.exe (the daemon) holds a lock on the destination, so say which
# process to stop rather than leaving a half-written binary.
function Install-StagedFile {
    param([string]$Stage, [string]$Name)
    $src = Join-Path $Stage $Name
    if (-not (Test-Path -LiteralPath $src)) { return }
    $dst = Join-Path $BinDir $Name
    $tmpDst = Join-Path $BinDir ('.' + $Name + '.tmp.' + $PID)
    Copy-Item -LiteralPath $src -Destination $tmpDst -Force
    try {
        Move-Item -LiteralPath $tmpDst -Destination $dst -Force -ErrorAction Stop
    } catch {
        Remove-Item -LiteralPath $tmpDst -Force -ErrorAction SilentlyContinue
        Assert-NotStopping $_
        Stop-WithError ('could not replace ' + $dst + ' - is hayven running? Stop it (hayven daemon stop) and re-run.
        ' + $_.Exception.Message)
    }
    Write-Log ('install-hayven: installed ' + $dst)
}

# Replace one staged directory beside the binary (viewer\dist, skill\), as
# install-hayven.sh does: resolveViewerDist / resolveSkillSource look next to
# the executable. Best-effort: skip silently if absent from the tarball.
function Install-StagedDir {
    param([string]$From, [string]$To)
    if (-not (Test-Path -LiteralPath $From -PathType Container)) { return }
    if (Test-Path -LiteralPath $To) { Remove-Item -LiteralPath $To -Recurse -Force }
    $parent = Split-Path -Parent $To
    if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
    Copy-Item -LiteralPath $From -Destination $To -Recurse -Force
}

# ---- install ----------------------------------------------------------------

$Platform = Get-Platform
$Tag = Resolve-LatestTag
if ($Tag -notmatch '^[vV]') { $Tag = 'v' + $Tag }   # accept "0.0.7" as "v0.0.7"
$VersionNumber = $Tag -replace '^[vV]', ''         # version = tag minus the leading "v"

$Tarball     = 'hayvenhurst-' + $VersionNumber + '-' + $Platform + '.tar.gz'
$BaseUrl     = 'https://github.com/' + $Repo + '/releases/download/' + $Tag
$TarballUrl  = $BaseUrl + '/' + $Tarball
$ChecksumUrl = $TarballUrl + '.sha256'
$BundleUrl   = $TarballUrl + '.sigstore.json'

Write-Log ('install-hayven: repo=' + $Repo + ' tag=' + $Tag + ' platform=' + $Platform)
Write-Log ('install-hayven: asset=' + $Tarball)

# Idempotence: re-running with the same version is a no-op, not a re-download.
# Only the prefix copy counts: a different hayven.exe elsewhere on PATH says
# nothing about whether THIS prefix is installed. BOTH binaries must report the
# version: an install interrupted between the two copies (Ctrl-C, or a running
# hayven-native.exe locking its file) leaves a new hayven.exe beside an old
# native binary, and checking hayven.exe alone would call that "nothing to do"
# forever - exactly when the error message told the user to re-run.
if (-not $Force) {
    $installed = Get-InstalledVersion $BinPath
    $nativeInstalled = Get-InstalledVersion (Join-Path $BinDir $NativeName)
    if ($null -ne $installed -and $installed -eq $VersionNumber -and $nativeInstalled -eq $VersionNumber) {
        Write-Log ('install-hayven: hayven ' + $installed + ' is already installed at ' + $BinPath + '; nothing to do (pass -Force to reinstall).')
        Write-PathHint
        exit 0
    }
}

# Allow a dry run of just the detection/mapping logic without network I/O.
if ($IsDryRun) {
    Write-Log ('DRY RUN: would download: ' + $TarballUrl)
    Write-Log ('DRY RUN: would verify:   ' + $ChecksumUrl)
    Write-Log ('DRY RUN: would verify:   ' + $BundleUrl)
    Write-Log ('DRY RUN: would install into: ' + $BinDir)
    Write-PathHint
    exit 0
}

# tar.exe (bsdtar) ships in Windows 10 1803+ / Windows 11. Prefer the System32
# copy: a Git-for-Windows MSYS tar earlier on PATH reads a leading "C:" as a
# remote host:path spec and fails on every drive-letter path.
$TarExe = $null
if (-not [string]::IsNullOrEmpty($env:SystemRoot)) {
    $sysTar = Join-Path $env:SystemRoot 'System32\tar.exe'
    if (Test-Path -LiteralPath $sysTar) { $TarExe = $sysTar }
}
if ($null -eq $TarExe) { $TarExe = Get-NativeExePath 'tar' }
if ($null -eq $TarExe) {
    Stop-WithError 'no tar.exe found. It ships with Windows 10 1803+ and Windows 11; on an older box, extract the release tarball manually.'
}

$Tmp = Join-Path ([System.IO.Path]::GetTempPath()) ('hayven-install.' + [System.Guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $Tmp -Force | Out-Null

# The finally runs on success, on Stop-WithError's exit, AND on Ctrl-C, so the
# temp dir never outlives the run.
try {
    $tarballPath = Join-Path $Tmp $Tarball
    $bundlePath  = $tarballPath + '.sigstore.json'

    Write-Log ('install-hayven: downloading ' + $TarballUrl)
    try {
        Get-RemoteFile -Uri $TarballUrl -OutFile $tarballPath
    } catch {
        Assert-NotStopping $_
        Stop-WithError ('download failed: ' + $TarballUrl + ' (does a release exist for ' + $Tag + ' / ' + $Platform + '?)
        ' + $_.Exception.Message)
    }

    # Verify sha256 against the published per-asset checksum file. The release
    # publishes `<tarball>.sha256` as "<hex>  <name>" (the Windows runner's
    # sha256sum writes "<hex> *<name>"; field 1 is the same either way).
    Write-Log 'install-hayven: verifying sha256'
    $checksumLine = ''
    try {
        $checksumLine = Get-RemoteString -Uri $ChecksumUrl
    } catch {
        Assert-NotStopping $_
        $checksumLine = ''
    }
    if ([string]::IsNullOrEmpty($checksumLine)) {
        Stop-WithError ('could not fetch checksum: ' + $ChecksumUrl)
    }
    $expected = ($checksumLine.Trim() -split '\s+')[0]
    if ([string]::IsNullOrEmpty($expected)) {
        Stop-WithError 'published checksum was empty'
    }
    if ($expected -notmatch '^[0-9A-Fa-f]{64}$') {
        Stop-WithError ('published checksum is not a sha256 hex digest: ' + $expected)
    }
    $actual = (Get-FileHash -LiteralPath $tarballPath -Algorithm SHA256).Hash
    if ($expected.ToLowerInvariant() -ne $actual.ToLowerInvariant()) {
        Stop-WithError ('checksum mismatch for ' + $Tarball + '
        expected: ' + $expected.ToLowerInvariant() + '
        actual:   ' + $actual.ToLowerInvariant())
    }
    Write-Log ('install-hayven: checksum OK (' + $actual.ToLowerInvariant() + ')')

    # Authenticity. The checksum above came from the same origin as the tarball,
    # so it proves nothing about provenance on its own.
    #
    # A missing bundle is ALWAYS fatal, never a skip. The tarball just
    # downloaded from this same origin, and every release since v0.0.6
    # publishes <tarball>.sigstore.json (release.yml refuses to publish without
    # it). So "tarball present, bundle absent" is not a benign 404 - it is
    # exactly what an attacker who can serve a tampered tarball would return in
    # order to strip the signature and downgrade us to the checksum, which they
    # also control.
    Write-Log 'install-hayven: fetching signature bundle'
    try {
        Get-RemoteFile -Uri $BundleUrl -OutFile $bundlePath
    } catch {
        Assert-NotStopping $_
        Stop-WithError ('no Sigstore bundle at ' + $BundleUrl + '
        The tarball downloaded but its signature did not. Refusing to install.
        Every Hayvenhurst release since v0.0.6 publishes <tarball>.sigstore.json,
        so a missing bundle means the release is malformed or the download was
        tampered with. (v0.0.5 and older predate signing: install those by hand
        from the release page, checking the .sha256.)')
    }
    Invoke-SignatureVerification -Bundle $bundlePath -Artifact $tarballPath -AssetName $Tarball -ReleaseTag $Tag

    Write-Log 'install-hayven: extracting'
    $untar = Invoke-Native -FilePath $TarExe -ArgumentList @('-xzf', $tarballPath, '-C', $Tmp)
    if ($untar.ExitCode -ne 0) {
        Stop-WithError ('tar failed to extract ' + $Tarball + '
        ' + $untar.Output)
    }

    # The tarball expands to a top-level dir: hayvenhurst-<version>-<platform>\
    # holding hayven.exe, hayven-native.exe, viewer\dist\, skill\, LICENSE and
    # README.md. Install exactly what install-hayven.sh installs: both binaries
    # plus viewer\dist and skill\ beside them (the docs stay in the tarball).
    $stage = Join-Path $Tmp ('hayvenhurst-' + $VersionNumber + '-' + $Platform)
    if (-not (Test-Path -LiteralPath $stage)) {
        Stop-WithError ('unexpected tarball layout (no ' + $stage + ')')
    }
    if (-not (Test-Path -LiteralPath (Join-Path $stage $BinName))) {
        Stop-WithError ('tarball is missing the ' + $BinName + ' binary')
    }

    if (-not (Test-Path -LiteralPath $BinDir)) {
        New-Item -ItemType Directory -Path $BinDir -Force | Out-Null
    }
    Install-StagedFile -Stage $stage -Name $BinName
    Install-StagedFile -Stage $stage -Name $NativeName
    Install-StagedDir -From (Join-Path $stage 'viewer\dist') -To (Join-Path $BinDir 'viewer\dist')
    Install-StagedDir -From (Join-Path $stage 'skill') -To (Join-Path $BinDir 'skill')
} finally {
    Remove-Item -LiteralPath $Tmp -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Log ''
Write-Log ('install-hayven: done. hayven ' + $VersionNumber + ' installed for ' + $Platform + '.')
Write-PathHint
Write-Log ''
Write-Log 'Next steps:'
Write-Log '  hayven init          # set up .hayven\ and do the first ingestion'
Write-Log '  hayven daemon start  # serves the code graph on :7777'
Write-SuiteHint
exit 0
