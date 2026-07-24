param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Sheet,
    [Parameter(Mandatory = $true)][string]$OutputPath
)

$Path = (Resolve-Path $Path).Path
$outDir = Split-Path -Parent $OutputPath
if (-not (Test-Path $outDir)) {
    New-Item -ItemType Directory -Path $outDir -Force | Out-Null
}

$excel = New-Object -ComObject Excel.Application
$excel.Visible = $false
$excel.DisplayAlerts = $false

try {
    $wb = $excel.Workbooks.Open($Path)
    $ws = $wb.Worksheets.Item($Sheet)
    if (-not $ws) {
        throw "Worksheet '$Sheet' was not found in $Path"
    }

    # Force print scaling: all columns fit on one page width.
    $ws.PageSetup.Zoom = $false
    $ws.PageSetup.FitToPagesWide = 1
    $ws.PageSetup.FitToPagesTall = $false
    $ws.PageSetup.Orientation = 2 # xlLandscape

    # 0 = xlTypePDF, Excel exports only this worksheet.
    $ws.ExportAsFixedFormat(0, $OutputPath)
    $wb.Close($false)
    $wb = $null
    Write-Output "Exported PDF: $OutputPath"
}
finally {
    if ($wb) {
        try { $wb.Close($false) | Out-Null } catch {}
    }
    $excel.Quit()
    [void][System.Runtime.Interopservices.Marshal]::ReleaseComObject($excel)
}
