param(
    [Parameter(Mandatory = $true)]
    [string]$Path,
    [string]$Password = '123456',
    [switch]$CloseOnly
)

$ErrorActionPreference = 'Stop'
$Path = [System.IO.Path]::GetFullPath($Path)
if (-not (Test-Path -LiteralPath $Path)) {
    throw "Workbook not found: $Path"
}

function Release-Com($obj) {
    if ($null -eq $obj) { return }
    try { [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($obj) } catch { }
}

function Unprotect-WorkbookObject($wb, [string]$pw) {
    try { $wb.Unprotect($pw) } catch { }
    try { $wb.Unprotect() } catch { }
    foreach ($ws in @($wb.Worksheets)) {
        try { $ws.Unprotect($pw) } catch { }
        try { $ws.Unprotect() } catch { }
    }
}

$closedExisting = $false
$excel = $null
try {
    $excel = [Runtime.InteropServices.Marshal]::GetActiveObject('Excel.Application')
} catch {
    $excel = $null
}

if ($excel) {
    foreach ($wb in @($excel.Workbooks)) {
        try {
            $full = [string]$wb.FullName
        } catch {
            continue
        }
        if (-not $full) { continue }
        if ([string]::Compare($full, $Path, $true) -ne 0) { continue }
        Unprotect-WorkbookObject $wb $Password
        if ($CloseOnly) {
            $wb.Close($false)
        } else {
            try { $wb.Save() } catch { }
            $wb.Close($false)
        }
        $closedExisting = $true
        Write-Output "Closed open workbook in Excel: $Path"
    }
    # Do not Quit a user-owned Excel instance — only close our workbook.
}

if (-not $closedExisting) {
    $owned = $null
    try {
        $owned = New-Object -ComObject Excel.Application
        $owned.Visible = $false
        $owned.DisplayAlerts = $false
        # Password = open password; WriteResPassword = write-reservation password
        $wb = $owned.Workbooks.Open($Path, $false, $false, [Type]::Missing, $Password, $Password)
        Unprotect-WorkbookObject $wb $Password
        if (-not $CloseOnly) {
            $wb.Save()
        }
        $wb.Close($false)
        Write-Output "Unlocked workbook: $Path"
    } finally {
        if ($owned) {
            try { $owned.Quit() } catch { }
            Release-Com $owned
        }
        [GC]::Collect()
        [GC]::WaitForPendingFinalizers()
    }
}
