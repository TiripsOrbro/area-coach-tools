param(
    [string]$Path = (Join-Path $PSScriptRoot '..\data\workbooks\Build To JS.xlsx'),
    [string]$Password = ''
)

$ErrorActionPreference = 'Stop'

function Release-Com($obj) {
    if ($null -eq $obj) { return }
    try { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($obj) } catch {}
}

$Path = (Resolve-Path -LiteralPath $Path).Path
$localPath = Join-Path $env:TEMP ("act-recalc-" + [guid]::NewGuid().ToString('N') + '.xlsx')
Copy-Item -LiteralPath $Path -Destination $localPath -Force

$excel = $null
$wb = $null
try {
    $excel = New-Object -ComObject Excel.Application
    $excel.Visible = $false
    $excel.DisplayAlerts = $false
    $excel.AskToUpdateLinks = $false

    if ([string]::IsNullOrWhiteSpace($Password)) {
        $wb = $excel.Workbooks.Open($localPath, 0, $false)
    } else {
        $wb = $excel.Workbooks.Open($localPath, 0, $false, [Type]::Missing, $Password, $Password)
        try { $wb.Unprotect($Password) } catch {}
        foreach ($ws in @($wb.Worksheets)) {
            try { $ws.Unprotect($Password) } catch {}
        }
    }

    $excel.CalculateFullRebuild()
    $wb.Save()
    $wb.Close($false)
    $wb = $null

    Copy-Item -LiteralPath $localPath -Destination $Path -Force
    Write-Output "Recalculated and saved: $Path"
}
finally {
    if ($wb) {
        try { $wb.Close($false) | Out-Null } catch {}
        Release-Com $wb
    }
    if ($excel) {
        try { $excel.Quit() | Out-Null } catch {}
        Release-Com $excel
    }
    if (Test-Path -LiteralPath $localPath) {
        Remove-Item -LiteralPath $localPath -Force -ErrorAction SilentlyContinue
    }
    [gc]::Collect()
    [gc]::WaitForPendingFinalizers()
}
