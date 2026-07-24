#Requires -Version 5.1
<#
.SYNOPSIS
  Installer / updater / launcher for Area Coach Tools.
.DESCRIPTION
  Prompts for install location (interactive), clones or updates from GitHub,
  builds Area Coach Tools.exe, creates Desktop/Start Menu shortcuts, and can
  launch the desktop app. Every .exe launch re-runs this script with -Quiet -Launch
  so Git changes are pulled before Electron starts.
.PARAMETER InstallDir
  Target folder. Interactive installs prompt when omitted.
.PARAMETER RepoUrl
  Git clone URL.
.PARAMETER NoLaunch
  Do not start the app after install/update.
.PARAMETER Quiet
  Non-interactive (no prompts). Implies -NoLaunch unless -Launch is set.
.PARAMETER Launch
  Start the desktop app after update (used by Area Coach Tools.exe).
.PARAMETER Bootstrap
  Steam-style install into -InstallDir without prompting for a folder.
  Used by Area Coach Tools.exe on first run (installs into the folder containing the .exe).
#>
param(
    [string]$InstallDir = '',
    [string]$RepoUrl = 'https://github.com/TiripsOrbro/area-coach-tools.git',
    [switch]$NoLaunch,
    [switch]$Quiet,
    [switch]$Launch,
    [switch]$Bootstrap
)

$ErrorActionPreference = 'Stop'
$NodeMinMajor = 18
$DefaultInstallDir = Join-Path $env:LOCALAPPDATA 'Programs\AreaCoachTools'
$ExeName = 'Area Coach Tools.exe'

function Write-Step([string]$Message) {
    Write-Host ''
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Assert-Command([string]$Name) {
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "Required command not found: $Name. Install it, then re-run this installer."
    }
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
    Write-Host "winget returned $code for $DisplayName - will try direct download."
    return $false
}

function Get-GitInstallerUrl {
    Enable-Tls12
    $rel = Invoke-RestMethod -Uri 'https://api.github.com/repos/git-for-windows/git/releases/latest' -UseBasicParsing
    $asset = $rel.assets |
        Where-Object { $_.name -match '^Git-[\d\.]+-64-bit\.exe$' } |
        Select-Object -First 1
    if (-not $asset) {
        throw 'Could not find a 64-bit Git for Windows installer on GitHub releases.'
    }
    return [string]$asset.browser_download_url
}

function Get-NodeLtsMsiUrl {
    Enable-Tls12
    $index = Invoke-RestMethod -Uri 'https://nodejs.org/dist/index.json' -UseBasicParsing
    $lts = $index | Where-Object { $_.lts -ne $false } | Select-Object -First 1
    if (-not $lts) { throw 'Could not resolve Node.js LTS version from nodejs.org.' }
    $ver = [string]$lts.version
    return "https://nodejs.org/dist/$ver/node-$ver-x64.msi"
}

function Install-GitFromDownload {
    Enable-Tls12
    $url = Get-GitInstallerUrl
    $exe = Join-Path $env:TEMP 'AreaCoachTools-Git-Setup.exe'
    Write-Host "Downloading Git..."
    Write-Host $url
    Invoke-WebRequest -Uri $url -OutFile $exe -UseBasicParsing
    Write-Host 'Installing Git (silent)...'
    $p = Start-Process -FilePath $exe -ArgumentList @(
        '/VERYSILENT', '/NORESTART', '/NOCANCEL', '/SP-',
        '/COMPONENTS=icons,ext\reg\shellhere,assoc,assoc_sh'
    ) -Wait -PassThru
    Refresh-Path
    # 0 ok, 3010 success but reboot recommended
    if ($p.ExitCode -ne 0 -and $p.ExitCode -ne 3010) {
        throw "Git installer failed (exit $($p.ExitCode))."
    }
}

function Install-NodeFromDownload {
    Enable-Tls12
    $url = Get-NodeLtsMsiUrl
    $msi = Join-Path $env:TEMP 'AreaCoachTools-Node-Setup.msi'
    Write-Host "Downloading Node.js LTS..."
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
    if (-not (Test-CommandExists git)) {
        Write-Step 'Installing Git'
        $ok = Invoke-WingetInstall -PackageId 'Git.Git' -DisplayName 'Git'
        if (-not $ok -or -not (Test-CommandExists git)) {
            Install-GitFromDownload
        }
        Refresh-Path
    }
    if (-not (Test-CommandExists git)) {
        throw 'Git is still missing after install. Install Git for Windows, then re-run.'
    }
    Write-Host "$(git --version)"
}

function Ensure-Node {
    Refresh-Path
    $major = Get-NodeMajor
    if ($major -lt $NodeMinMajor) {
        if ($major -lt 0) {
            Write-Step 'Installing Node.js'
        }
        else {
            Write-Step "Upgrading Node.js (found v$major, need $NodeMinMajor+)"
        }
        $ok = Invoke-WingetInstall -PackageId 'OpenJS.NodeJS.LTS' -DisplayName 'Node.js LTS'
        if (-not $ok -or ((Get-NodeMajor) -lt $NodeMinMajor)) {
            Install-NodeFromDownload
        }
        Refresh-Path
    }

    if (-not (Test-CommandExists node) -or -not (Test-CommandExists npm)) {
        throw 'Node.js / npm is still missing after install. Install Node.js 18+, then re-run.'
    }
    $major = Get-NodeMajor
    if ($major -lt $NodeMinMajor) {
        throw "Node.js $NodeMinMajor+ is required (found major $major)."
    }
    Write-Host "Node $(node -v) / npm $(npm -v)"
}

function Resolve-InstallDir {
    param([string]$Requested, [switch]$Interactive)

    if ($Requested) {
        return [System.IO.Path]::GetFullPath($Requested.Trim().Trim('"'))
    }

    if (-not $Interactive) {
        return $DefaultInstallDir
    }

    Write-Host ''
    Write-Host 'Where should Area Coach Tools be installed?' -ForegroundColor Yellow
    Write-Host "  Press Enter for default:"
    Write-Host "  $DefaultInstallDir"
    Write-Host '  Or type a full folder path (example: D:\Apps\AreaCoachTools)'
    Write-Host '  Or type B to open a folder browser'
    $answer = Read-Host 'Install folder'
    $answer = if ($null -eq $answer) { '' } else { $answer.Trim().Trim('"') }

    if (-not $answer) {
        return $DefaultInstallDir
    }

    if ($answer -match '^[Bb]$') {
        Add-Type -AssemblyName System.Windows.Forms | Out-Null
        $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
        $dialog.Description = 'Choose install folder for Area Coach Tools'
        $dialog.ShowNewFolderButton = $true
        if (Test-Path -LiteralPath $DefaultInstallDir) {
            $dialog.SelectedPath = $DefaultInstallDir
        }
        $result = $dialog.ShowDialog()
        if ($result -ne [System.Windows.Forms.DialogResult]::OK -or -not $dialog.SelectedPath) {
            throw 'Install cancelled - no folder selected.'
        }
        return [System.IO.Path]::GetFullPath($dialog.SelectedPath)
    }

    return [System.IO.Path]::GetFullPath($answer)
}

# Git prints progress on stderr; with $ErrorActionPreference=Stop, `git ... 2>&1 | Out-Null`
# turns those lines into terminating NativeCommandError even when exit code is 0.
function Invoke-Git {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$Arguments,
        [switch]$Quiet,
        [string]$FailMessage = 'git command failed'
    )

    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $output = @()
    try {
        $output = & git @Arguments 2>&1
        $code = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $prev
    }

    if (-not $Quiet -and $output) {
        foreach ($line in $output) {
            $text = if ($line -is [System.Management.Automation.ErrorRecord]) {
                $line.ToString()
            } else {
                "$line"
            }
            if ($text.Trim()) { Write-Host $text }
        }
    }

    if ($code -ne 0) {
        $detail = ($output | ForEach-Object { "$_" } | Where-Object { $_.Trim() } | Select-Object -Last 8) -join "`n"
        if ($detail) {
            throw "$FailMessage`n$detail"
        }
        throw $FailMessage
    }
    return $code
}

function Invoke-GitCleanPreservingLocal {
    Invoke-Git -Quiet -FailMessage 'git clean failed' -Arguments @(
        'clean', '-fd',
        '-e', '.env',
        '-e', 'desktop/users.seed.json',
        '-e', 'dashboard/data',
        '-e', 'forecast/data',
        '-e', 'stores/data',
        '-e', 'data/prep-guides',
        '-e', $ExeName,
        '-e', 'Area Coach Tools.exe',
        '-e', 'AreaCoachTools-Setup.exe',
        '-e', 'AreaCoachTools.exe',
        '-e', 'AreaCoachToolsSetup.exe',
        '-e', 'Install-AreaCoachTools.ps1'
    )
}

function Update-FromGit {
    param([string]$Dir, [string]$Url)

    # Always return a single boolean via this variable (git stdout must not leak into the pipeline).
    $didChange = $false

    if ($Dir -match '(?i)OneDrive|Google Drive|Dropbox') {
        Write-Host ''
        Write-Host 'Warning: install folder is under a cloud sync path (OneDrive/etc).' -ForegroundColor Yellow
        Write-Host 'Prefer a local folder such as:' -ForegroundColor Yellow
        Write-Host "  $DefaultInstallDir" -ForegroundColor Yellow
        Write-Host ''
    }

    if (Test-Path (Join-Path $Dir '.git')) {
        Push-Location $Dir
        try {
            Invoke-Git -Quiet -FailMessage 'git remote set-url failed' -Arguments @('remote', 'set-url', 'origin', $Url)
            Invoke-Git -Quiet -FailMessage 'git fetch failed (check internet / GitHub access)' -Arguments @('fetch', '--prune', 'origin')

            $branch = ''
            $ErrorActionPreference = 'Continue'
            try { $branch = (git rev-parse --abbrev-ref HEAD 2>$null | Out-String).Trim() } catch { $branch = '' }
            $ErrorActionPreference = 'Stop'
            if ($branch -eq 'HEAD' -or -not $branch) { $branch = 'main' }
            $remoteRef = "origin/$branch"
            $ErrorActionPreference = 'Continue'
            git show-ref --verify --quiet "refs/remotes/$remoteRef"
            $hasRemote = ($LASTEXITCODE -eq 0)
            $ErrorActionPreference = 'Stop'
            if (-not $hasRemote) {
                $branch = 'main'
                $remoteRef = 'origin/main'
            }

            $local = (git rev-parse HEAD).Trim()
            $remote = (git rev-parse $remoteRef).Trim()
            if ($local -eq $remote) {
                $short = (git rev-parse --short HEAD).Trim()
                Write-Host "Already up to date ($short on $branch)"
                $didChange = $false
            }
            else {
                Write-Host "Updating $($local.Substring(0, 7)) -> $($remote.Substring(0, 7)) ($branch)"
                Invoke-Git -Quiet -FailMessage 'git checkout failed' -Arguments @('checkout', '-B', $branch, $remoteRef)
                Invoke-Git -Quiet -FailMessage 'git reset --hard failed' -Arguments @('reset', '--hard', $remoteRef)
                Invoke-GitCleanPreservingLocal
                $short = (git rev-parse --short HEAD).Trim()
                Write-Host "Updated to $short ($branch)"
                $didChange = $true
            }
        }
        finally {
            Pop-Location
        }
        return $didChange
    }

    $parent = Split-Path -Parent $Dir
    if ($parent) {
        New-Item -ItemType Directory -Force -Path $parent | Out-Null
    }

    # Steam-style: folder already exists (contains Setup.exe). Never wipe it.
    if (Test-Path -LiteralPath $Dir) {
        Write-Host "Initializing Git repo in existing folder (keeping Setup.exe)..."
        Push-Location $Dir
        try {
            Invoke-Git -Quiet -FailMessage 'git init failed' -Arguments @('init')
            $prevEap = $ErrorActionPreference
            $ErrorActionPreference = 'Continue'
            git remote remove origin 2>$null | Out-Null
            git remote add origin $Url 2>$null | Out-Null
            $addOk = ($LASTEXITCODE -eq 0)
            $ErrorActionPreference = $prevEap
            if (-not $addOk) {
                Invoke-Git -Quiet -FailMessage 'git remote set-url failed' -Arguments @('remote', 'set-url', 'origin', $Url)
            }
            Invoke-Git -Quiet -FailMessage 'git fetch failed (check internet / GitHub access)' -Arguments @('fetch', '--prune', 'origin')
            $ErrorActionPreference = 'Continue'
            git show-ref --verify --quiet 'refs/remotes/origin/main'
            $hasMain = ($LASTEXITCODE -eq 0)
            $ErrorActionPreference = 'Stop'
            if (-not $hasMain) { throw 'origin/main not found after fetch' }
            Invoke-Git -Quiet -FailMessage 'git checkout main failed' -Arguments @('checkout', '-f', '-B', 'main', 'origin/main')
            Invoke-GitCleanPreservingLocal
            Write-Host "Checked out $(git rev-parse --short HEAD) (main)"
        }
        finally {
            Pop-Location
        }
        return $true
    }

    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    & git clone --branch main --single-branch $Url $Dir 2>$null | Out-Null
    $cloneOk = ($LASTEXITCODE -eq 0)
    $ErrorActionPreference = $prevEap
    if (-not $cloneOk) {
        Invoke-Git -Quiet -FailMessage "git clone failed for $Url" -Arguments @('clone', $Url, $Dir)
    }
    return $true
}

function Install-NpmDeps {
    param([string]$Dir)

    Push-Location $Dir
    try {
        Write-Step 'npm install (server)'
        npm install --no-fund --no-audit
        if ($LASTEXITCODE -ne 0) { throw 'npm install (server) failed' }

        Write-Step 'npm install (desktop)'
        npm run desktop:install
        if ($LASTEXITCODE -ne 0) { throw 'npm install (desktop) failed' }

        Write-Step 'npm install (built-in Build-to)'
        npm run buildto:install
        if ($LASTEXITCODE -ne 0) { throw 'npm install (build-to) failed' }
    }
    finally {
        Pop-Location
    }
}

function Test-NeedsNpmInstall {
    param([string]$Dir)

    $serverMods = Join-Path $Dir 'node_modules'
    $desktopMods = Join-Path $Dir 'desktop\node_modules'
    $electron = Join-Path $Dir 'desktop\node_modules\electron'
    $buildToMods = Join-Path $Dir 'mmx-report-automation\node_modules'
    $buildToPkg = Join-Path $Dir 'mmx-report-automation\package.json'
    $buildToOk = -not (Test-Path $buildToPkg) -or (Test-Path $buildToMods)
    return -not (
        (Test-Path $serverMods) -and
        (Test-Path $desktopMods) -and
        (Test-Path $electron) -and
        $buildToOk
    )
}

function Build-LauncherExe {
    param([string]$Dir)

    # Unified app entrypoint (install + update + launch). Prefer Setup.cs over legacy launcher.
    $cs = Join-Path $Dir 'tools\AreaCoachToolsSetup.cs'
    if (-not (Test-Path $cs)) {
        $cs = Join-Path $Dir 'tools\AreaCoachToolsLauncher.cs'
    }
    $outExe = Join-Path $Dir $ExeName
    if (-not (Test-Path $cs)) {
        Write-Host "App source missing ($cs) - falling back to .cmd launcher only."
        return $null
    }

    $iconIco = Join-Path $Dir 'desktop\build\icon.ico'

    # Bootstrap: this .exe is already running — never try to overwrite it.
    if ($Bootstrap -and (Test-Path $outExe)) {
        Write-Host "Keeping existing $ExeName (bootstrap already running)."
        return $outExe
    }

    # Keep an existing exe if source + icon are not newer (also avoids overwrite while the exe is running).
    if (Test-Path $outExe) {
        $exeInfo = Get-Item -LiteralPath $outExe
        $newestSrc = (Get-Item -LiteralPath $cs).LastWriteTimeUtc
        if (Test-Path $iconIco) {
            $iconUtc = (Get-Item -LiteralPath $iconIco).LastWriteTimeUtc
            if ($iconUtc -gt $newestSrc) { $newestSrc = $iconUtc }
        }
        if ($exeInfo.LastWriteTimeUtc -ge $newestSrc) {
            Write-Host "App already present: $outExe"
            return $outExe
        }
    }

    $frameworkRoots = @(
        (Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319'),
        (Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319')
    )
    $csc = $null
    foreach ($root in $frameworkRoots) {
        $candidate = Join-Path $root 'csc.exe'
        if (Test-Path $candidate) {
            $csc = $candidate
            break
        }
    }
    if (-not $csc) {
        if (Test-Path $outExe) { return $outExe }
        Write-Host 'csc.exe not found - falling back to .cmd launcher only.'
        return $null
    }

    Write-Step "Building $ExeName"
    $compileArgs = @(
        '/nologo',
        '/target:winexe',
        "/out:$outExe",
        '/reference:System.Windows.Forms.dll',
        '/reference:System.Drawing.dll',
        '/reference:System.dll'
    )
    if (Test-Path $iconIco) {
        $compileArgs += "/win32icon:$iconIco"
    }
    $compileArgs += $cs
    try {
        & $csc @compileArgs
        if ($LASTEXITCODE -ne 0 -or -not (Test-Path $outExe)) {
            if (Test-Path $outExe) { return $outExe }
            Write-Host 'App compile failed - falling back to .cmd launcher only.'
            return $null
        }
    }
    catch {
        if (Test-Path $outExe) {
            Write-Host "Could not rebuild app (in use) - keeping existing $ExeName"
            return $outExe
        }
        Write-Host "App compile failed: $($_.Exception.Message)"
        return $null
    }
    Write-Host "Created $outExe"
    return $outExe
}

function Write-LauncherScripts {
    param([string]$Dir)

    $launchPath = Join-Path $Dir 'Launch-AreaCoachTools.cmd'
    $updatePath = Join-Path $Dir 'Update-AreaCoachTools.cmd'
    $ps1Name = 'Install-AreaCoachTools.ps1'

    $launchBody = @(
        '@echo off'
        'setlocal'
        'cd /d "%~dp0"'
        "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"%~dp0$ps1Name`" -InstallDir `"%~dp0.`" -Quiet -Launch"
        'exit /b %ERRORLEVEL%'
    ) -join "`r`n"
    Set-Content -Encoding ASCII -Path $launchPath -Value $launchBody

    $updateBody = @(
        '@echo off'
        'setlocal'
        'cd /d "%~dp0"'
        "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"%~dp0$ps1Name`" -InstallDir `"%~dp0.`" -Quiet -NoLaunch"
        'exit /b %ERRORLEVEL%'
    ) -join "`r`n"
    Set-Content -Encoding ASCII -Path $updatePath -Value $updateBody

    return $launchPath
}

function New-AppShortcuts {
    param([string]$TargetPath, [string]$WorkDir)

    $wsh = New-Object -ComObject WScript.Shell
    $desktop = [Environment]::GetFolderPath('Desktop')
    $startMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'

    foreach ($folder in @($desktop, $startMenu)) {
        if (-not (Test-Path $folder)) {
            New-Item -ItemType Directory -Force -Path $folder | Out-Null
        }
        $lnk = Join-Path $folder 'Area Coach Tools.lnk'
        $sc = $wsh.CreateShortcut($lnk)
        $sc.TargetPath = $TargetPath
        $sc.WorkingDirectory = $WorkDir
        $sc.Description = 'Area Coach Tools - check Git for updates, then launch'
        $iconIco = Join-Path $WorkDir 'desktop\build\icon.ico'
        if (Test-Path $iconIco) {
            $sc.IconLocation = "$iconIco,0"
        }
        $sc.Save()
    }
}

function Ensure-EnvFile {
    param([string]$Dir)

    Push-Location $Dir
    try {
        if (-not (Test-Path '.env') -and (Test-Path '.env.example')) {
            Copy-Item '.env.example' '.env'
            Write-Host 'Created .env from .env.example - edit STORE_* paths and secrets as needed.'
        }
        # Build-to automation is shipped under mmx-report-automation/ (built-in).
        # Do not force MMX_REPORT_AUTOMATION_DIR to an external sibling folder.
    }
    finally {
        Pop-Location
    }
}

# --- main ---
# Bootstrap / Quiet never prompt for a folder (Steam-style Setup.exe always passes -InstallDir).
$interactive = -not $Quiet -and -not $Bootstrap
if ($Bootstrap -and -not $InstallDir) {
    throw 'Bootstrap requires -InstallDir (folder containing Area Coach Tools.exe).'
}
$InstallDir = Resolve-InstallDir -Requested $InstallDir -Interactive:$interactive

Write-Host 'Area Coach Tools installer' -ForegroundColor Green
Write-Host "Repo: $RepoUrl"
Write-Host "Install dir: $InstallDir"
if ($Bootstrap) {
    Write-Host 'Mode: Bootstrap (Steam-style - install into Setup.exe folder)'
}

Ensure-Git
Ensure-Node

Write-Step 'Checking GitHub for updates'
$changed = Update-FromGit -Dir $InstallDir -Url $RepoUrl

Ensure-EnvFile -Dir $InstallDir

$needNpm = $changed -or (Test-NeedsNpmInstall -Dir $InstallDir)
if ($needNpm) {
    if ($changed) {
        Write-Host 'Code changed - refreshing npm dependencies.'
    }
    else {
        Write-Host 'Dependencies missing - running npm install.'
    }
    Install-NpmDeps -Dir $InstallDir
}
else {
    Write-Host 'Dependencies already present - skipping npm install.'
}

Write-Step 'Creating launchers and shortcuts'
$cmdLauncher = Write-LauncherScripts -Dir $InstallDir
$exeLauncher = Build-LauncherExe -Dir $InstallDir
# Rebuild distributable dist\ copy only on interactive / bootstrap installs (not every Quiet launch).
if (-not $Quiet -or ($Bootstrap -and $changed)) {
    try {
        $setupScript = Join-Path $InstallDir 'tools\Build-SetupExe.ps1'
        if (Test-Path $setupScript) {
            $distDir = Join-Path $InstallDir 'dist'
            Write-Step "Building dist\$ExeName"
            & powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File $setupScript -OutDir $distDir -OutName $ExeName | Out-Host
        }
    }
    catch {
        Write-Host "dist exe build skipped: $($_.Exception.Message)"
    }
}
$shortcutTarget = if ($exeLauncher) { $exeLauncher } else { $cmdLauncher }
New-AppShortcuts -TargetPath $shortcutTarget -WorkDir $InstallDir

Write-Host ''
Write-Host 'Ready.' -ForegroundColor Green
Write-Host "Folder: $InstallDir"
if ($exeLauncher) {
    Write-Host "App:    $exeLauncher"
}
else {
    Write-Host "App:    $cmdLauncher"
}
Write-Host 'Shortcuts: Desktop + Start Menu -> Area Coach Tools'
Write-Host 'Opening the app checks GitHub and downloads changes before launch.'

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
    $desktopDir = Join-Path $InstallDir 'desktop'
    $electronCandidates = @(
        (Join-Path $desktopDir 'node_modules\electron\dist\electron.exe'),
        (Join-Path $InstallDir 'node_modules\electron\dist\electron.exe')
    )
    $electronExe = $electronCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1

    if ($electronExe) {
        # Detach so this script (and any host console) can exit immediately — no cmd window.
        $p = Start-Process -FilePath $electronExe -ArgumentList @('.') -WorkingDirectory $desktopDir -WindowStyle Normal -PassThru
        Write-Host "Launched Electron (pid $($p.Id))"
    }
    else {
        Write-Host 'electron.exe not found - falling back to npm start (may flash a console)...'
        $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
        if (-not $npm) { $npm = Get-Command npm -ErrorAction SilentlyContinue }
        if (-not $npm) { throw 'npm not found; cannot start desktop app.' }
        Start-Process -FilePath $npm.Source -ArgumentList @('start') -WorkingDirectory $desktopDir -WindowStyle Hidden
        Write-Host 'Launched via npm start (detached).'
    }
}
