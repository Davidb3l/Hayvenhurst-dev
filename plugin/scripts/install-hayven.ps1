<#
.SYNOPSIS
    Download + install the platform-correct `hayven` / `hayven-native` binaries
    from a Hayvenhurst GitHub Release. Native Windows port of install-hayven.sh.

.DESCRIPTION
    WHY this exists: the Claude Code plugin is git-based, so installing the
    plugin only clones the repo's text files (the Agent Skill). It does NOT
    deliver the compiled `hayven` CLI / `hayven-native` binary - those are
    platform-specific and large, and are deliberately NOT committed to git.
    So this script is the bridge: map to the windows-x64 release tarball asset
    (mirroring .github/workflows/release.yml's platform matrix), download it,
    verify its sha256 against the published `<tarball>.sha256`, and install the
    binaries - plus viewer\dist and skill\ - into a known location.

    install-hayven.sh already covers Windows under Git Bash / MSYS2 / Cygwin.
    This file is for a native Windows shell with no POSIX layer installed: same
    asset, same layout, same checksum verification, same exit codes.

    A checksum mismatch ALWAYS aborts and nothing is installed.

    Idempotent and safe to re-run (e.g. to upgrade). Windows PowerShell 5.1
    compatible; also runs on PowerShell 7+.

    Exit codes: 0 success, 1 error, 2 bad usage, 3 not installed (-Check only).

.PARAMETER Prefix
    Install prefix; binaries land in <Prefix>\bin. Defaults to
    $env:HAYVEN_INSTALL_PREFIX, then $env:CLAUDE_PLUGIN_DATA (set when the
    plugin invokes this, so the install survives plugin updates), then
    $env:USERPROFILE\.local - i.e. %USERPROFILE%\.local\bin by default.

.PARAMETER Version
    Install a specific release tag (e.g. v0.0.7) instead of the latest.
    Defaults to $env:HAYVEN_RELEASE_TAG.

.PARAMETER Repo
    Override owner/repo. Defaults to $env:HAYVEN_REPO, then
    Davidb3l/Hayvenhurst-dev.

.PARAMETER Check
    Print status only and never download. Exits 0 if `hayven` is on PATH or
    already installed under the prefix, 3 if it is missing.

.PARAMETER AddToPath
    Append the install directory to the per-user PATH (no admin needed).
    Without this switch the script only PRINTS the command to do so - it never
    edits your PATH behind your back.

.EXAMPLE
    .\install-hayven.ps1
    Install the latest release into %USERPROFILE%\.local\bin.

.EXAMPLE
    .\install-hayven.ps1 -Version v0.0.7 -Prefix D:\tools\hayven -AddToPath
    Pin a tag, install into D:\tools\hayven\bin, and put it on the user PATH.

.EXAMPLE
    .\install-hayven.ps1 -Check
    Report install status without touching the network.

.NOTES
    Set $env:HAYVEN_INSTALL_DRY_RUN = '1' to exercise the detection and asset
    mapping with no network I/O and no install.
#>
[CmdletBinding()]
param(
    [string] $Prefix,
    [string] $Version,
    [string] $Repo,
    [switch] $Check,
    [switch] $AddToPath
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
# Invoke-WebRequest's progress bar costs more wall-clock than the download on
# Windows PowerShell 5.1. Silence it for this process only.
$ProgressPreference = 'SilentlyContinue'

# ---- small helpers ----------------------------------------------------------
# The sh script logs to stderr so stdout stays clean; the PowerShell equivalent
# is the information stream, which Write-Host writes to on 5.1 and 7 alike.
function Write-Log {
    param([string] $Message = '')
    Write-Host $Message
}

function Stop-WithError {
    param([string] $Message)
    Write-Host "install-hayven: error: $Message" -ForegroundColor Red
    exit 1
}

function Test-Have {
    param([string] $Name)
    $null -ne (Get-Command $Name -ErrorAction SilentlyContinue)
}

# ---- configuration ----------------------------------------------------------
if (-not $Repo)    { $Repo    = $env:HAYVEN_REPO }
if (-not $Repo)    { $Repo    = 'Davidb3l/Hayvenhurst-dev' }
if (-not $Version) { $Version = $env:HAYVEN_RELEASE_TAG }

if (-not $Prefix)  { $Prefix = $env:HAYVEN_INSTALL_PREFIX }
if (-not $Prefix)  { $Prefix = $env:CLAUDE_PLUGIN_DATA }
if (-not $Prefix) {
    # USERPROFILE can be unset in stripped service accounts / some CI images.
    # Without it there is no defensible install location, so say that rather
    # than writing into "\.local\bin" off the current drive root.
    if ($env:USERPROFILE) {
        $Prefix = Join-Path $env:USERPROFILE '.local'
    } elseif (-not $Check) {
        Stop-WithError "cannot determine an install prefix (USERPROFILE is unset). Pass -Prefix <dir> or set HAYVEN_INSTALL_PREFIX."
    } else {
        # -Check has nothing to inspect, but `hayven` on PATH still answers the
        # real question. A path that cannot exist keeps the Test-Path checks
        # false without printing a plausible-looking but wrong location.
        $Prefix = 'X:\nonexistent-hayven-prefix'
    }
}

$BinDir = Join-Path $Prefix 'bin'

# The release matrix builds Windows binaries with a .exe suffix
# (release.yml: hayven_bin: hayven.exe, native_bin: hayven-native.exe).
$HayvenExe = 'hayven.exe'
$NativeExe = 'hayven-native.exe'

# ---- suite awareness --------------------------------------------------------
# Hayvenhurst is the code graph of a four-tool suite: Ametrite holds the task
# board, Sirius Forester runs the foreman loop, Catryna Wikinelli keeps the
# living docs. One short nudge, only when something is missing.
function Test-SuiteRepo {
    # HOME IS NEVER A SUITE REPO. $env:USERPROFILE\.hayven is the GLOBAL config
    # dir (registry, writer id, logs), so a bare "is there a .hayven" answers
    # "yes, a project" whenever a session starts in the user profile dir.
    if ($env:USERPROFILE -and (Test-Path -LiteralPath $env:USERPROFILE)) {
        $here = (Get-Location).ProviderPath
        $home_ = (Resolve-Path -LiteralPath $env:USERPROFILE).ProviderPath
        if ($here.TrimEnd('\') -eq $home_.TrimEnd('\')) { return $false }
    }
    # .docs\ alone is too generic a name; require Catryna's index file.
    if (Test-Path '.sirius')           { return $true }
    if (Test-Path '.ametrite')         { return $true }
    if (Test-Path '.hayven')           { return $true }
    if (Test-Path '.docs\_index.json') { return $true }
    return $false
}

function Write-SuiteHint {
    $missing = @()
    if (-not (Test-Have 'amt'))    { $missing += 'Ametrite' }
    if (-not (Test-Have 'sirius')) { $missing += 'Sirius' }
    # Prefix match: catryna installs as catryna@<marketplace> and there are two
    # legitimate marketplaces (its own catryna-wikinelli, and the Sothis bundle
    # sirius-forester). Pinning one key nags bundle users forever.
    $pluginsFile = if ($env:USERPROFILE) { Join-Path $env:USERPROFILE '.claude\plugins\installed_plugins.json' } else { $null }
    $hasCatryna = $false
    if ($pluginsFile -and (Test-Path -LiteralPath $pluginsFile)) {
        $hasCatryna = [bool](Select-String -LiteralPath $pluginsFile -Pattern '"catryna@' -SimpleMatch -Quiet)
    }
    if (-not $hasCatryna) { $missing += 'Catryna' }
    if ($missing.Count -eq 0) { return }

    Write-Log ''
    Write-Log ("fleet suite: missing: " + ($missing -join ' ') + ". Hayvenhurst is the suite's code graph; for full fleet control install the whole suite:")
    if ($missing -contains 'Sirius')   { Write-Log '  Sirius Forester (fleet foreman): /plugin marketplace add Davidb3l/Sirius-Forester, /plugin install sirius@sirius-forester, then /sirius:install-binary' }
    if ($missing -contains 'Catryna')  { Write-Log '  Catryna Wikinelli (code wiki): /plugin marketplace add Davidb3l/Catryna-Wikinelli, then /plugin install catryna@catryna-wikinelli (Sothis bundle users: /plugin install catryna@sirius-forester)' }
    if ($missing -contains 'Ametrite') { Write-Log '  Ametrite (task board): ask Claude to "ametrite this repo" (the skill bootstraps the amt CLI)' }
}

# ---- PATH advisory ----------------------------------------------------------
function Test-OnPath {
    $entries = @()
    if ($env:Path) { $entries = $env:Path -split ';' }
    foreach ($e in $entries) {
        if ($e -and ($e.TrimEnd('\') -ieq $BinDir.TrimEnd('\'))) { return $true }
    }
    return $false
}

function Write-PathHint {
    if (Test-OnPath) { return }
    Write-Log ''
    Write-Log "note: $BinDir is not on your PATH."
    Write-Log '      Add it for your user account (no admin needed):'
    Write-Log ("        [Environment]::SetEnvironmentVariable('Path', [Environment]::GetEnvironmentVariable('Path','User') + ';" + $BinDir + "', 'User')")
    Write-Log '      ...or re-run this installer with -AddToPath to do exactly that.'
    Write-Log '      Then restart your shell (and any editor or terminal that inherited the'
    Write-Log '      old PATH) before `hayven` resolves. This installer never edits your'
    Write-Log '      PATH unless you pass -AddToPath.'
}

function Add-ToUserPath {
    # Read the REGISTRY value, never $env:Path: the process PATH is the merged
    # machine+user+session copy, and writing it back to 'User' would clone every
    # machine entry into the user scope permanently.
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    if ($null -eq $userPath) { $userPath = '' }
    $already = $false
    foreach ($e in ($userPath -split ';')) {
        if ($e -and ($e.TrimEnd('\') -ieq $BinDir.TrimEnd('\'))) { $already = $true }
    }
    if ($already) {
        Write-Log "install-hayven: $BinDir is already on your user PATH"
    } else {
        $sep = ''
        if ($userPath -and -not $userPath.EndsWith(';')) { $sep = ';' }
        [Environment]::SetEnvironmentVariable('Path', ($userPath + $sep + $BinDir), 'User')
        Write-Log "install-hayven: added $BinDir to your user PATH"
    }
    # Make it usable in THIS session too, without waiting for a restart.
    if (-not (Test-OnPath)) { $env:Path = $env:Path + ';' + $BinDir }
    Write-Log '      Restart your shell (and any editor or terminal that inherited the old'
    Write-Log '      PATH) for other programs to see it.'
}

# ---- -Check: status only, never downloads -----------------------------------
if ($Check) {
    $onPath = Get-Command 'hayven' -ErrorAction SilentlyContinue
    if ($onPath) {
        Write-Log "hayven: already on PATH ($($onPath.Source))"
        if (Test-SuiteRepo) { Write-SuiteHint }
        exit 0
    }
    if (Test-Path -LiteralPath (Join-Path $BinDir $HayvenExe)) {
        Write-Log "hayven: installed at $(Join-Path $BinDir $HayvenExe) (not on PATH)"
        Write-PathHint
        if (Test-SuiteRepo) { Write-SuiteHint }
        exit 0
    }
    Write-Log 'hayven: not installed. Run /hayvenhurst:install-binary (or plugin\scripts\install-hayven.ps1) to install it.'
    if (Test-SuiteRepo) { Write-SuiteHint }
    exit 3
}

# ---- platform detection -> release asset name -------------------------------
# The release matrix publishes exactly one Windows target: windows-x64. There is
# no windows-arm64 tarball to fall back to - but Windows on ARM runs x64 PE
# binaries under emulation, and Git Bash (x86_64) already takes this same path
# there, so ARM64 warns and proceeds rather than dead-ending. A 32-bit-only host
# has neither an asset nor an emulation story, so it stops.
$procArch = $env:PROCESSOR_ARCHITECTURE
if (-not $procArch) { $procArch = 'unknown' }
switch ($procArch) {
    'AMD64' { break }
    'ARM64' {
        Write-Log "install-hayven: WARNING: $procArch host - installing the windows-x64 build,"
        Write-Log 'install-hayven: WARNING: which Windows on ARM runs under x64 emulation.'
        break
    }
    default {
        Stop-WithError "unsupported CPU arch '$procArch' (the release matrix publishes windows-x64 only)."
    }
}
$Platform = 'windows-x64'

if (-not (Test-Have 'tar.exe')) {
    Stop-WithError 'tar.exe not found. It ships with Windows 10 1803+ and Windows 11; on older builds extract hayvenhurst-<version>-windows-x64.tar.gz manually, or run install-hayven.sh under Git Bash.'
}

# ---- resolve the release tag ------------------------------------------------
# Windows PowerShell 5.1 does not negotiate TLS 1.2 by default on older builds,
# and github.com refuses anything less. Widen it for this process only.
try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
} catch { }

function Resolve-LatestTag {
    # /releases/latest 302-redirects to /releases/tag/<TAG>: no API token and no
    # rate limit. Fall back to the public API if the redirect is unreadable.
    try {
        $resp = Invoke-WebRequest -Uri "https://github.com/$Repo/releases/latest" -UseBasicParsing -Method Head
        $final = $null
        try { $final = $resp.BaseResponse.ResponseUri.AbsoluteUri } catch { }          # PS 5.1
        if (-not $final) {
            try { $final = $resp.BaseResponse.RequestMessage.RequestUri.AbsoluteUri } catch { }  # PS 7+
        }
        if ($final -and ($final -match '/releases/tag/(.+)$')) { return $Matches[1] }
    } catch { }
    try {
        $headers = @{ 'User-Agent' = 'install-hayven.ps1' }
        $json = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest" -UseBasicParsing -Headers $headers
        if ($json -and $json.tag_name) { return $json.tag_name }
    } catch { }
    return $null
}

$Tag = $Version
if (-not $Tag) { $Tag = Resolve-LatestTag }
if (-not $Tag) {
    Stop-WithError "could not resolve the latest release tag for $Repo (pass -Version vX.Y.Z)"
}

$Ver         = $Tag -replace '^v', ''
$Tarball     = "hayvenhurst-$Ver-$Platform.tar.gz"
$BaseUrl     = "https://github.com/$Repo/releases/download/$Tag"
$TarballUrl  = "$BaseUrl/$Tarball"
$ChecksumUrl = "$TarballUrl.sha256"

Write-Log "install-hayven: repo=$Repo tag=$Tag platform=$Platform"
Write-Log "install-hayven: asset=$Tarball"

# Allow a dry run of just the detection/mapping logic without network I/O.
if ($env:HAYVEN_INSTALL_DRY_RUN -eq '1') {
    Write-Log "DRY RUN: would download: $TarballUrl"
    Write-Log "DRY RUN: would verify:   $ChecksumUrl"
    Write-Log "DRY RUN: would install into: $BinDir"
    exit 0
}

# ---- download ---------------------------------------------------------------
$Tmp = Join-Path ([IO.Path]::GetTempPath()) ("hayven-install." + [Guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $Tmp -Force | Out-Null

try {
    $tarballPath = Join-Path $Tmp $Tarball

    Write-Log "install-hayven: downloading $TarballUrl"
    try {
        Invoke-WebRequest -Uri $TarballUrl -OutFile $tarballPath -UseBasicParsing
    } catch {
        Stop-WithError "download failed: $TarballUrl (does a release exist for $Tag / $Platform?)`n        $($_.Exception.Message)"
    }

    # ---- verify sha256 ------------------------------------------------------
    # The release publishes <tarball>.sha256 in `shasum -a 256` format:
    # "<hex>  <name>". A mismatch aborts before anything is written to $BinDir.
    Write-Log 'install-hayven: verifying sha256'
    $checksumLine = $null
    try {
        $checksumLine = (Invoke-WebRequest -Uri $ChecksumUrl -UseBasicParsing).Content
    } catch {
        $checksumLine = $null
    }
    if (-not $checksumLine) { Stop-WithError "could not fetch checksum: $ChecksumUrl" }

    $expected = ($checksumLine -split '\s+' | Where-Object { $_ })[0]
    if (-not $expected) { Stop-WithError 'published checksum was empty' }
    $actual = (Get-FileHash -LiteralPath $tarballPath -Algorithm SHA256).Hash

    if ($expected -ine $actual) {
        Stop-WithError "checksum mismatch for $Tarball`n        expected: $expected`n        actual:   $actual"
    }
    Write-Log "install-hayven: checksum OK ($actual)"

    # ---- extract ------------------------------------------------------------
    Write-Log 'install-hayven: extracting'
    & tar.exe -xzf $tarballPath -C $Tmp
    if ($LASTEXITCODE -ne 0) { Stop-WithError "tar.exe failed to extract $Tarball (exit $LASTEXITCODE)" }

    # The tarball expands to a top-level dir: hayvenhurst-<version>-<platform>\
    $Stage = Join-Path $Tmp "hayvenhurst-$Ver-$Platform"
    if (-not (Test-Path -LiteralPath $Stage)) { Stop-WithError "unexpected tarball layout (no $Stage)" }
    if (-not (Test-Path -LiteralPath (Join-Path $Stage $HayvenExe))) {
        Stop-WithError "tarball is missing the $HayvenExe binary"
    }

    # ---- install ------------------------------------------------------------
    New-Item -ItemType Directory -Path $BinDir -Force | Out-Null

    # Install both binaries; hayven-native.exe goes beside hayven.exe so the
    # daemon's subprocess transport finds it. Atomic-ish: write then move into
    # place.
    function Install-One {
        param([string] $Name)
        $src = Join-Path $Stage $Name
        if (-not (Test-Path -LiteralPath $src)) { return }
        $dst    = Join-Path $BinDir $Name
        $tmpDst = Join-Path $BinDir (".$Name.tmp." + $PID)
        Copy-Item -LiteralPath $src -Destination $tmpDst -Force
        try {
            Move-Item -LiteralPath $tmpDst -Destination $dst -Force
        } catch {
            Remove-Item -LiteralPath $tmpDst -Force -ErrorAction SilentlyContinue
            # Windows locks a RUNNING .exe, so an upgrade fails while the daemon
            # is up. Say which door to close.
            Stop-WithError "could not replace $dst - Windows locks an executable while it runs.`n        Stop it (``hayven daemon stop``), close anything else using it, then re-run.`n        $($_.Exception.Message)"
        }
        Write-Log "install-hayven: installed $dst"
    }
    Install-One $HayvenExe
    Install-One $NativeExe

    # Bundle viewer\dist + skill\ beside the binary too, so a plugin install gets
    # the same layout a tarball install does (resolveViewerDist /
    # resolveSkillSource look next to the executable). Best-effort: skip
    # silently if absent.
    $viewerSrc = Join-Path $Stage 'viewer\dist'
    if (Test-Path -LiteralPath $viewerSrc) {
        $viewerDst = Join-Path $BinDir 'viewer'
        if (Test-Path -LiteralPath $viewerDst) {
            Remove-Item -LiteralPath $viewerDst -Recurse -Force
        }
        New-Item -ItemType Directory -Path $viewerDst -Force | Out-Null
        # Copy the DIRECTORY (not its contents) so it lands as viewer\dist,
        # matching resolveViewerDist's <exeDir>\viewer\dist.
        Copy-Item -LiteralPath $viewerSrc -Destination (Join-Path $viewerDst 'dist') -Recurse -Force
    }
    $skillSrc = Join-Path $Stage 'skill'
    if (Test-Path -LiteralPath $skillSrc) {
        $skillDst = Join-Path $BinDir 'skill'
        if (Test-Path -LiteralPath $skillDst) {
            Remove-Item -LiteralPath $skillDst -Recurse -Force
        }
        # Copy the DIRECTORY onto a name that does NOT exist yet (the Remove-Item
        # above guarantees that), so hayvenhurst.md lands directly under
        # <exeDir>\skill\ for resolveSkillSource. Copying onto an EXISTING
        # directory instead nests it as skill\skill\, which is why the target is
        # deliberately not pre-created here.
        Copy-Item -LiteralPath $skillSrc -Destination $skillDst -Recurse -Force
    }
} finally {
    Remove-Item -LiteralPath $Tmp -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Log ''
Write-Log "install-hayven: done. hayven $Ver installed for $Platform."
if ($AddToPath) { Add-ToUserPath } else { Write-PathHint }
Write-Log ''
Write-Log 'Next steps:'
Write-Log '  hayven init          # set up .hayven\ and do the first ingestion'
Write-Log '  hayven daemon start  # serves the code graph on :7777'
Write-SuiteHint
exit 0
