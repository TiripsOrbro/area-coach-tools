#Requires -Version 5.1
<#
.SYNOPSIS
  Install Git for Windows and Node.js LTS for Area Coach Tools.
.DESCRIPTION
  Standalone prerequisite installer. Run this once on a new PC, then run
  Area Coach Tools.exe (or Install-AreaCoachTools).

  Prefers winget; falls back to silent downloads from GitHub / nodejs.org.
  Requests Administrator if needed.
#>
param(
    [switch]$NoPause
)

$ErrorActionPreference = 'Stop'
$NodeMinMajor = 18

function Write-Step([string]$Message) {
    Write-Host ''
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Test-IsAdmin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($id)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Request-Elevation {
    if (Test-IsAdmin) { return }
    Write-Host 'Requesting Administrator approval...' -ForegroundColor Yellow
    $ps1 = $PSCommandPath
    if (-not $ps1) { $ps1 = $MyInvocation.MyCommand.Path }
    $args = @(
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-File', "`"$ps1`""
    )
    if ($NoPause) { $args += '-NoPause' }
    $p = Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList $args -Wait -PassThru
    exit $p.ExitCode
}

function Test-CommandExists([string]$Name) {
    return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

function Refresh-Path {
    $machine = [System.Environment]::GetEnvironmentVariable('Path', 'Machine')
    $user = [System.Environment]::GetEnvironmentVariable('Path', 'User')
    $extra = @(
        'C:\Program Files\Git\cmd',
        'C:\Program Files\Git\bin',
        'C:\Program Files\nodejs',
        (Join-Path $env:LOCALAPPDATA 'Programs\Git\cmd'),
        (Join-Path $env:LOCALAPPDATA 'Programs\nodejs')
    ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }

    $parts = @()
    foreach ($chunk in @($machine, $user, ($extra -join ';'), $env:Path)) {
        if ($chunk) { $parts += $chunk }
    }
    $env:Path = ($parts -join ';')
}

function Get-NodeMajor {
    if (-not (Test-CommandExists node)) { return -1 }
    try {
        $version = (& node -v 2>$null) -replace '^v', ''
        if (-not $version) { return -1 }
        return [int]($version.Split('.')[0])
    }
    catch {
        return -1
    }
}

function Enable-Tls12 {
    try {
        [Net.ServicePointManager]::SecurityProtocol = `
            [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    }
    catch { }
}

function Invoke-WingetInstall {
    param(
        [Parameter(Mandatory = $true)][string]$PackageId,
        [Parameter(Mandatory = $true)][string]$DisplayName
    )

    if (-not (Test-CommandExists winget)) { return $false }

    Write-Host "Installing $DisplayName via winget ($PackageId)..."
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & winget install --id $PackageId -e --source winget `
            --accept-package-agreements --accept-source-agreements `
            --disable-interactivity | Out-Host
        $code = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $prev
    }
    Refresh-Path

    # 0 = success; -1978335189 (0x8A15002B) = already installed
    if ($code -eq 0 -or $code -eq -1978335189) { return $true }
    Write-Host "winget returned $code for $DisplayName - trying direct download."
    return $false
}

function Get-GitInstallerUrl {
    Enable-Tls12
    try {
        $rel = Invoke-RestMethod -Uri 'https://api.github.com/repos/git-for-windows/git/releases/latest' -UseBasicParsing
        $asset = $rel.assets |
            Where-Object { $_.name -match '^Git-[\d\.]+-64-bit\.exe$' } |
            Select-Object -First 1
        if ($asset) { return [string]$asset.browser_download_url }
    }
    catch {
        Write-Host "GitHub release lookup failed: $($_.Exception.Message)"
    }
    # Fallback pin (updated periodically)
    return 'https://github.com/git-for-windows/git/releases/download/v2.49.0.windows.1/Git-2.49.0-64-bit.exe'
}

function Get-NodeLtsMsiUrl {
    Enable-Tls12
    try {
        $index = Invoke-RestMethod -Uri 'https://nodejs.org/dist/index.json' -UseBasicParsing
        $lts = $index | Where-Object { $_.lts -ne $false } | Select-Object -First 1
        if ($lts) {
            $ver = [string]$lts.version
            return "https://nodejs.org/dist/$ver/node-$ver-x64.msi"
        }
    }
    catch {
        Write-Host "Node LTS lookup failed: $($_.Exception.Message)"
    }
    return 'https://nodejs.org/dist/v22.17.0/node-v22.17.0-x64.msi'
}

function Install-GitFromDownload {
    Enable-Tls12
    $url = Get-GitInstallerUrl
    $exe = Join-Path $env:TEMP 'AreaCoachTools-Git-Setup.exe'
    Write-Host 'Downloading Git...'
    Write-Host $url
    Invoke-WebRequest -Uri $url -OutFile $exe -UseBasicParsing
    Write-Host 'Installing Git (silent)...'
    $p = Start-Process -FilePath $exe -ArgumentList @(
        '/VERYSILENT', '/NORESTART', '/NOCANCEL', '/SP-',
        '/COMPONENTS=icons,ext\reg\shellhere,assoc,assoc_sh'
    ) -Wait -PassThru
    Refresh-Path
    if ($p.ExitCode -ne 0 -and $p.ExitCode -ne 3010) {
        throw "Git installer failed (exit $($p.ExitCode))."
    }
}

function Install-NodeFromDownload {
    Enable-Tls12
    $url = Get-NodeLtsMsiUrl
    $msi = Join-Path $env:TEMP 'AreaCoachTools-Node-Setup.msi'
    Write-Host 'Downloading Node.js LTS...'
    Write-Host $url
    Invoke-WebRequest -Uri $url -OutFile $msi -UseBasicParsing
    Write-Host 'Installing Node.js (silent)...'
    $p = Start-Process -FilePath 'msiexec.exe' -ArgumentList "/i `"$msi`" /qn /norestart" -Wait -PassThru
    Refresh-Path
    if ($p.ExitCode -ne 0 -and $p.ExitCode -ne 3010) {
        throw "Node.js installer failed (exit $($p.ExitCode))."
    }
}

function Ensure-Git {
    Refresh-Path
    if (Test-CommandExists git) {
        Write-Host "Git already installed: $(git --version)"
        return
    }
    Write-Step 'Installing Git'
    $ok = Invoke-WingetInstall -PackageId 'Git.Git' -DisplayName 'Git'
    if (-not $ok -or -not (Test-CommandExists git)) {
        Install-GitFromDownload
    }
    Refresh-Path
    if (-not (Test-CommandExists git)) {
        throw 'Git is still missing after install.'
    }
    Write-Host "OK: $(git --version)"
}

function Ensure-Node {
    Refresh-Path
    $major = Get-NodeMajor
    if ($major -ge $NodeMinMajor -and (Test-CommandExists npm)) {
        Write-Host "Node already installed: $(node -v) / npm $(npm -v)"
        return
    }
    if ($major -lt 0) {
        Write-Step 'Installing Node.js LTS'
    }
    else {
        Write-Step "Upgrading Node.js (found major $major, need $NodeMinMajor+)"
    }
    $ok = Invoke-WingetInstall -PackageId 'OpenJS.NodeJS.LTS' -DisplayName 'Node.js LTS'
    if (-not $ok -or ((Get-NodeMajor) -lt $NodeMinMajor)) {
        Install-NodeFromDownload
    }
    Refresh-Path
    if (-not (Test-CommandExists node) -or -not (Test-CommandExists npm)) {
        throw 'Node.js / npm is still missing after install.'
    }
    $major = Get-NodeMajor
    if ($major -lt $NodeMinMajor) {
        throw "Node.js $NodeMinMajor+ is required (found major $major)."
    }
    Write-Host "OK: Node $(node -v) / npm $(npm -v)"
}

# --- main ---
try {
    Request-Elevation

    Write-Host 'Area Coach Tools - Prerequisites' -ForegroundColor Green
    Write-Host 'Installs Git and Node.js LTS if missing.'
    Write-Host ''

    Ensure-Git
    Ensure-Node

    Write-Host ''
    Write-Host 'Prerequisites ready.' -ForegroundColor Green
    Write-Host 'Next: run Area Coach Tools.exe (or Install-AreaCoachTools).'
    Write-Host 'Prefer a local folder (not OneDrive).'
    $code = 0
}
catch {
    Write-Host ''
    Write-Host "FAILED: $($_.Exception.Message)" -ForegroundColor Red
    $code = 1
}

if (-not $NoPause) {
    Write-Host ''
    Read-Host 'Press Enter to close'
}
exit $code
