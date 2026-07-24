#Requires -Version 5.1
<#
.SYNOPSIS
  Render public/shared/icon.svg (heartbeat) into desktop/build/icon.png + multi-size icon.ico.
#>
param(
    [int]$MasterSize = 512
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$svg = Join-Path $Root 'public\shared\icon.svg'
$build = Join-Path $Root 'desktop\build'
$outPng = Join-Path $build 'icon.png'
$outIco = Join-Path $build 'icon.ico'
if (-not (Test-Path $svg)) { throw "Missing $svg" }
New-Item -ItemType Directory -Force -Path $build | Out-Null

$edge = @(
    (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'),
    (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe'),
    (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe')
) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if (-not $edge) { throw 'Edge/Chrome not found to render SVG.' }

$tmpHtml = Join-Path $env:TEMP 'act-icon-render.html'
$tmpPng = Join-Path $env:TEMP ("act-icon-{0}.png" -f $MasterSize)
$svgUri = (New-Object System.Uri ((Resolve-Path $svg).Path)).AbsoluteUri
$htmlUri = (New-Object System.Uri $tmpHtml).AbsoluteUri
@"
<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>
html,body{margin:0;padding:0;width:${MasterSize}px;height:${MasterSize}px;overflow:hidden;background:#000;}
img{width:${MasterSize}px;height:${MasterSize}px;display:block;}
</style></head>
<body><img src="$svgUri" width="$MasterSize" height="$MasterSize" alt="icon"/></body></html>
"@ | Set-Content -Path $tmpHtml -Encoding UTF8

Remove-Item $tmpPng -Force -ErrorAction SilentlyContinue
& $edge --headless=new --disable-gpu --hide-scrollbars --window-size=$MasterSize,$MasterSize --screenshot="$tmpPng" $htmlUri | Out-Null
Start-Sleep -Milliseconds 800
if (-not (Test-Path $tmpPng)) { throw "Screenshot failed: $tmpPng" }
Copy-Item -Force $tmpPng $outPng

Add-Type -AssemblyName System.Drawing
$sizes = @(16, 24, 32, 48, 64, 128, 256)
$src = [System.Drawing.Bitmap]::FromFile((Resolve-Path $outPng))
$pngBlobs = @()
foreach ($s in $sizes) {
    $bmp = New-Object System.Drawing.Bitmap $s, $s
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.Clear([System.Drawing.Color]::Transparent)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    $g.DrawImage($src, 0, 0, $s, $s)
    $g.Dispose()
    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $pngBlobs += , $ms.ToArray()
    $ms.Dispose(); $bmp.Dispose()
}
$src.Dispose()

$fs = New-Object System.IO.MemoryStream
$bw = New-Object System.IO.BinaryWriter $fs
$bw.Write([uint16]0)
$bw.Write([uint16]1)
$bw.Write([uint16]$sizes.Count)
$dataOffset = [uint32](6 + (16 * $sizes.Count))
$imageData = New-Object System.Collections.Generic.List[byte]
for ($i = 0; $i -lt $sizes.Count; $i++) {
    $s = $sizes[$i]
    $data = $pngBlobs[$i]
    $bw.Write([byte]($(if ($s -ge 256) { 0 } else { $s })))
    $bw.Write([byte]($(if ($s -ge 256) { 0 } else { $s })))
    $bw.Write([byte]0)
    $bw.Write([byte]0)
    $bw.Write([uint16]1)
    $bw.Write([uint16]32)
    $bw.Write([uint32]$data.Length)
    $bw.Write([uint32]$dataOffset)
    $dataOffset += [uint32]$data.Length
    $imageData.AddRange($data)
}
$bw.Flush()
[IO.File]::WriteAllBytes($outIco, ($fs.ToArray() + $imageData.ToArray()))
$bw.Dispose(); $fs.Dispose()

Write-Host "OK: $outPng"
Write-Host "OK: $outIco ($($sizes -join ', ') px)"
return $outIco
