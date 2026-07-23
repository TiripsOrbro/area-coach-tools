#Requires -Version 5.1
<#
.SYNOPSIS
  Single-file installer / updater for Area Coach Tools.
.DESCRIPTION
  Clones or hard-resets to the latest GitHub main branch, runs npm install,
  creates Desktop + Start Menu shortcuts, and optionally launches the app.
.PARAMETER InstallDir
  Target folder. Default: %LOCALAPPDATA%\Programs\AreaCoachTools
.PARAMETER RepoUrl
  Git clone URL.
.PARAMETER NoLaunch
  Skip the launch prompt / do not start the app.
.PARAMETER Quiet
  Non-interactive (no prompts). Implies -NoLaunch unless -Launch is set.
.PARAMETER Launch
  Start the desktop app after install (useful with -Quiet).
#>
param(
    [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'Programs\AreaCoachTools'),
    [string]$RepoUrl = 'https://github.com/TiripsOrbro/area-coach-tools.git',
    [switch]$NoLaunch,
    [switch]$Quiet,
    [switch]$Launch
)

$ErrorActionPreference = 'Stop'
$NodeMinMajor = 18

function Write-Step([string]$Message) {
    Write-Host "`n==> $Message" -ForegroundColor Cyan
}

function Assert-Command([string]$Name) {
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "Required command not found: $Name. Install it, then re-run this installer."
    }
}

function Ensure-Node {
    Assert-Command node
    Assert-Command npm
    $version = (node -v) -replace '^v', ''
    $major = [int]($version.Split('.')[0])
    if ($major -lt $NodeMinMajor) {
        throw "Node.js $NodeMinMajor+ is required (found v$version). Install from https://nodejs.org"
    }
    Write-Host "Node $(node -v) / npm $(npm -v)"
}

function Ensure-Git {
    Assert-Command git
    Write-Host "$(git --version)"
}

function Update-FromGit {
    param([string]$Dir, [string]$Url)

    if (Test-Path (Join-Path $Dir '.git')) {
        Push-Location $Dir
        try {
            git remote set-url origin $Url
            git fetch --prune origin
            $branch = (git rev-parse --abbrev-ref HEAD).Trim()
            if ($branch -eq 'HEAD' -or -not $branch) { $branch = 'main' }
            $remoteRef = "origin/$branch"
            git show-ref --verify --quiet "refs/remotes/$remoteRef"
            if ($LASTEXITCODE -ne 0) {
                $branch = 'main'
                $remoteRef = 'origin/main'
            }
            git checkout -B $branch $remoteRef
            git reset --hard $remoteRef
            git clean -fd `
                -e .env `
                -e 'desktop/users.seed.json' `
                -e 'dashboard/data' `
                -e 'forecast/data' `
                -e 'stores/data' `
                -e 'data/prep-guides'
            Write-Host "Updated to $(git rev-parse --short HEAD) ($branch)"
        }
        finally {
            Pop-Location
        }
        return
    }

    $parent = Split-Path -Parent $Dir
    if ($parent) {
        New-Item -ItemType Directory -Force -Path $parent | Out-Null
    }
    if (Test-Path $Dir) {
        Remove-Item -Recurse -Force $Dir
    }
    git clone --branch main --single-branch $Url $Dir
    if ($LASTEXITCODE -ne 0) {
        git clone $Url $Dir
        if ($LASTEXITCODE -ne 0) { throw "git clone failed for $Url" }
    }
}

function Write-LauncherScripts {
    param([string]$Dir)

    $launchPath = Join-Path $Dir 'Launch-AreaCoachTools.cmd'
    $updatePath = Join-Path $Dir 'Update-AreaCoachTools.cmd'
    $ps1Name = 'Install-AreaCoachTools.ps1'

    @"
@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0$ps1Name" -InstallDir "%~dp0." -Quiet -Launch
exit /b %ERRORLEVEL%
"@ | Set-Content -Encoding ASCII -Path $launchPath

    @"
@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0$ps1Name" -InstallDir "%~dp0." -Quiet -NoLaunch
exit /b %ERRORLEVEL%
"@ | Set-Content -Encoding ASCII -Path $updatePath

    return $launchPath
}

function New-AppShortcuts {
    param([string]$TargetCmd, [string]$WorkDir)

    $wsh = New-Object -ComObject WScript.Shell
    $desktop = [Environment]::GetFolderPath('Desktop')
    $startMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'

    foreach ($folder in @($desktop, $startMenu)) {
        $lnk = Join-Path $folder 'Area Coach Tools.lnk'
        $sc = $wsh.CreateShortcut($lnk)
        $sc.TargetPath = $TargetCmd
        $sc.WorkingDirectory = $WorkDir
        $sc.Description = 'Area Coach Tools — pull latest from Git, then launch'
        $sc.Save()
    }
}

Write-Host 'Area Coach Tools installer' -ForegroundColor Green
Write-Host "Repo: $RepoUrl"
Write-Host "Install dir: $InstallDir"

Ensure-Git
Ensure-Node

Write-Step 'Fetching latest from GitHub'
Update-FromGit -Dir $InstallDir -Url $RepoUrl

Push-Location $InstallDir
try {
    Write-Step 'Configuring .env'
    if (-not (Test-Path '.env') -and (Test-Path '.env.example')) {
        Copy-Item '.env.example' '.env'
        Write-Host 'Created .env from .env.example — edit STORE_* paths and secrets as needed.'
    }

    Write-Step 'npm install (server)'
    npm install --no-fund --no-audit
    if ($LASTEXITCODE -ne 0) { throw 'npm install (server) failed' }

    Write-Step 'npm install (desktop)'
    npm run desktop:install
    if ($LASTEXITCODE -ne 0) { throw 'npm install (desktop) failed' }

    Write-Step 'Creating launchers and shortcuts'
    $launcher = Write-LauncherScripts -Dir $InstallDir
    New-AppShortcuts -TargetCmd $launcher -WorkDir $InstallDir

    Write-Host ''
    Write-Host 'Install complete.' -ForegroundColor Green
    Write-Host "Folder: $InstallDir"
    Write-Host 'Shortcuts: Desktop + Start Menu → Area Coach Tools'
    Write-Host 'Each launch runs a Git update first, then starts the desktop app.'

    $shouldLaunch = $false
    if ($Launch) {
        $shouldLaunch = $true
    }
    elseif (-not $NoLaunch -and -not $Quiet) {
        $answer = Read-Host 'Launch now? [Y/n]'
        $shouldLaunch = ($answer -notmatch '^[Nn]')
    }

    if ($shouldLaunch) {
        Write-Step 'Starting desktop app'
        npm run desktop:start
    }
}
finally {
    Pop-Location
}
