#Requires -Version 5.1
<#
.SYNOPSIS
  Compile the unified Area Coach Tools.exe (install + update + launch).
.DESCRIPTION
  Output defaults to dist\Area Coach Tools.exe (share this single file).
  Users place it in a folder and run it; first run installs, later runs update+launch.
#>
param(
    [string]$OutDir = '',
    [string]$OutName = 'Area Coach Tools.exe'
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Cs = Join-Path $PSScriptRoot 'AreaCoachToolsSetup.cs'
if (-not (Test-Path $Cs)) { throw "Missing $Cs" }

if (-not $OutDir) {
    $OutDir = Join-Path $Root 'dist'
}
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$OutExe = Join-Path $OutDir $OutName

$frameworkRoots = @(
    (Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319'),
    (Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319')
)
$csc = $null
foreach ($fr in $frameworkRoots) {
    $candidate = Join-Path $fr 'csc.exe'
    if (Test-Path $candidate) { $csc = $candidate; break }
}
if (-not $csc) { throw 'csc.exe not found (need .NET Framework 4.x).' }

# Prefer heartbeat icon; rebuild from SVG if missing
$IconIco = Join-Path $Root 'desktop\build\icon.ico'
$iconScript = Join-Path $PSScriptRoot 'Build-AppIcon.ps1'
if (-not (Test-Path $IconIco) -and (Test-Path $iconScript)) {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $iconScript | Out-Host
}

$compileArgs = @(
    '/nologo',
    '/target:winexe',
    "/out:$OutExe",
    '/reference:System.Windows.Forms.dll',
    '/reference:System.Drawing.dll',
    '/reference:System.dll'
)
if (Test-Path $IconIco) {
    $compileArgs += "/win32icon:$IconIco"
    Write-Host "Using app icon: $IconIco"
} else {
    Write-Warning 'No desktop\build\icon.ico - exe will use the default icon.'
}
$compileArgs += $Cs

Write-Host "Compiling $OutExe"
& $csc @compileArgs
if ($LASTEXITCODE -ne 0 -or -not (Test-Path $OutExe)) {
    throw 'Area Coach Tools.exe compile failed'
}

# Copy to repo root for easy grabbing
$rootCopy = Join-Path $Root $OutName
try {
    Copy-Item -Force $OutExe $rootCopy
} catch {
    Write-Host "Root copy skipped (file in use): $rootCopy"
}

# Remove legacy dual-exe names so only the unified file remains when possible
foreach ($legacy in @('AreaCoachTools-Setup.exe', 'AreaCoachTools.exe', 'AreaCoachToolsSetup.exe')) {
    foreach ($dir in @($OutDir, $Root)) {
        $p = Join-Path $dir $legacy
        if (Test-Path $p) {
            try { Remove-Item -Force $p } catch { }
        }
    }
}

# Bundle first-time Git/Node helper next to the .exe for new PCs
foreach ($helper in @('Install-Prerequisites.cmd', 'Install-Prerequisites.ps1')) {
    $src = Join-Path $Root $helper
    if (Test-Path -LiteralPath $src) {
        Copy-Item -Force $src (Join-Path $OutDir $helper)
    }
}

Write-Host "OK: $OutExe"
Write-Host 'Distribute that .exe plus Install-Prerequisites.cmd/.ps1 for new PCs.'
Write-Host 'First run installs into its folder; later runs update + launch.'
return $OutExe
