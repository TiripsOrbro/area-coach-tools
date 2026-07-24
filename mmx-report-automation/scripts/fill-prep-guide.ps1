param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$PayloadPath
)

$ErrorActionPreference = 'Stop'

function Release-Com($obj) {
    if ($null -eq $obj) { return }
    try { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($obj) } catch {}
}

if (-not (Test-Path -LiteralPath $Path)) { throw "Workbook not found: $Path" }
if (-not (Test-Path -LiteralPath $PayloadPath)) { throw "Payload not found: $PayloadPath" }

$step = 'load-payload'
$payload = Get-Content -LiteralPath $PayloadPath -Raw -Encoding UTF8 | ConvertFrom-Json
$destPath = (Resolve-Path -LiteralPath $Path).Path
$localPath = Join-Path $env:TEMP ("act-prep-guide-" + [guid]::NewGuid().ToString('N') + '.xlsx')
Copy-Item -LiteralPath $destPath -Destination $localPath -Force

$excel = $null
$wb = $null
try {
    $step = 'open-excel'
    $excel = New-Object -ComObject Excel.Application
    $excel.Visible = $false
    $excel.DisplayAlerts = $false
    $excel.AskToUpdateLinks = $false
    $excel.AlertBeforeOverwriting = $false
    try { $excel.ScreenUpdating = $false } catch {}

    $step = 'open-workbook'
    $wb = $excel.Workbooks.Open($localPath, 0, $false)
    if (-not $wb) { throw "Excel failed to open $localPath" }
    try { $excel.Calculation = -4135 } catch {} # xlCalculationManual (optional)

    $label = [string]$payload.storeLabel
    $days = @('Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday')

    $step = 'weekly-forecast'
    $wf = $wb.Worksheets.Item('Weekly Forecast')
    $wf.Cells.Item(2, 2).NumberFormat = '@'
    $wf.Cells.Item(2, 2).Value2 = [string]'Forecast Sales $'
    $wf.Cells.Item(1, 3).NumberFormat = '@'
    $wf.Cells.Item(1, 3).Value2 = [string]'Week'
    $wf.Cells.Item(2, 3).Value2 = [double]$payload.weekTotal
    for ($i = 0; $i -lt 7; $i++) {
        $col = 4 + $i
        $name = $days[$i]
        $wf.Cells.Item(1, $col).NumberFormat = '@'
        $wf.Cells.Item(1, $col).Value2 = [string]$name
        $wf.Cells.Item(2, $col).Value2 = [double]$payload.forecast.$name
    }

    $step = 'day-calcs-name'
    foreach ($day in $days) {
        $calcs = $wb.Worksheets.Item("$day Calcs")
        $calcs.Cells.Item(3, 8).NumberFormat = '@'
        $calcs.Cells.Item(3, 8).Value2 = $label
    }

    $step = 'sales'
    $sales = $wb.Worksheets.Item('Sales')
    $sales.Cells.Item(1, 1).Value2 = [string]$label
    foreach ($day in $days) {
        $step = "sales-$day"
        $block = $payload.sales.$day
        if (-not $block) { continue }
        $baseCol = [int]$block.baseCol
        $weeks = @($block.weeks)
        for ($w = 0; $w -lt 5; $w++) {
            $col = $baseCol + $w
            $week = $weeks[$w]
            try {
                $phase = 'date'
                $dateCell = $sales.Cells.Item(6, $col)
                if ($null -ne $week -and $week.dateKey) {
                    $dateCell.Value2 = [string]$week.dateKey
                } else {
                    $dateCell.ClearContents() | Out-Null
                }
                $src = @()
                if ($null -ne $week) { $src = @($week.hours) }
                for ($h = 0; $h -lt 24; $h++) {
                    $phase = "hour-$h"
                    $v = 0.0
                    if ($h -lt $src.Count -and $null -ne $src[$h] -and "$($src[$h])" -ne '') {
                        $v = [double]$src[$h]
                    }
                    # Text avoids COM Double→String cast on oddly formatted cells.
                    $sales.Cells.Item(7 + $h, $col).Value2 = [string]$v
                }
            } catch {
                throw "sales $day week=$w col=${col} phase=${phase}: $($_.Exception.Message)"
            }
        }
    }

    $step = 'ise'
    $ise = $wb.Worksheets.Item('ISE Average')
    $ise.Cells.Item(1, 1).NumberFormat = '@'
    $ise.Cells.Item(1, 1).Value2 = $label
    $ise.Range('A5:AX300').ClearContents() | Out-Null

    # Row 3 weekday labels
    for ($d = 0; $d -lt 7; $d++) {
        $baseCol = 3 + ($d * 7)
        $dayName = $days[$d]
        for ($w = 0; $w -lt 5; $w++) {
            $ise.Cells.Item(3, $baseCol + $w).NumberFormat = '@'
            $ise.Cells.Item(3, $baseCol + $w).Value2 = [string]$dayName
        }
        $ise.Cells.Item(3, $baseCol + 5).NumberFormat = '@'
        $ise.Cells.Item(3, $baseCol + 5).Value2 = [string]("Average of ${dayName}s")
    }
    $ise.Cells.Item(4, 1).NumberFormat = '@'
    $ise.Cells.Item(4, 1).Value2 = 'Item'
    $ise.Cells.Item(4, 2).NumberFormat = '@'
    $ise.Cells.Item(4, 2).Value2 = 'Description'

    $items = @($payload.iseItems)
    $n = $items.Count
    if ($n -gt 0) {
        $cols = 50
        for ($r = 0; $r -lt $n; $r++) {
            $item = $items[$r]
            $excelRow = 5 + $r
            $rowArr = New-Object object[] $cols
            for ($c = 0; $c -lt $cols; $c++) { $rowArr[$c] = $null }

            $codeStr = [string]$item.code
            if ($codeStr -match '^\d+$') { $rowArr[0] = [string]$codeStr }
            else { $rowArr[0] = $codeStr }
            $rowArr[1] = [string]$item.description

            for ($d = 0; $d -lt 7; $d++) {
                $dayName = $days[$d]
                $baseCol = 3 + ($d * 7) # 1-based
                $dayBlock = $item.days.$dayName
                $vals = @($dayBlock.values)
                for ($w = 0; $w -lt 5; $w++) {
                    $c0 = ($baseCol - 1) + $w
                    if ($w -lt $vals.Count -and $null -ne $vals[$w] -and "$($vals[$w])" -ne '') {
                        $rowArr[$c0] = [string]([double]$vals[$w])
                    }
                }
                $avgCol0 = ($baseCol - 1) + 5
                if ($null -ne $dayBlock.avg -and "$($dayBlock.avg)" -ne '') {
                    $rowArr[$avgCol0] = [string]([double]$dayBlock.avg)
                } else {
                    $rowArr[$avgCol0] = '0'
                }
                if ($r -eq 0 -and $dayBlock.excelSerials) {
                    $serials = @($dayBlock.excelSerials)
                    for ($w = 0; $w -lt 5; $w++) {
                        if ($w -lt $serials.Count -and $null -ne $serials[$w] -and "$($serials[$w])" -ne '') {
                            $ise.Cells.Item(2, $baseCol + $w).Value2 = [string]$serials[$w]
                        }
                    }
                }
            }
            for ($c = 0; $c -lt $cols; $c++) {
                $val = $rowArr[$c]
                if ($null -eq $val) { continue }
                $ise.Cells.Item($excelRow, $c + 1).Value2 = [string]$val
            }
        }
    }

    $step = 'calculate-save'
    try { $excel.Calculation = -4105 } catch {} # xlCalculationAutomatic
    try { $excel.CalculateFullRebuild() } catch { $excel.Calculate() }
    $wb.Save()
    $wb.Close($false)
    $wb = $null

    $step = 'copy-back'
    Copy-Item -LiteralPath $localPath -Destination $destPath -Force
    Write-Output "Filled Prep Guide (COM): $destPath"
}
catch {
    throw "fill-prep-guide failed at step '$step': $($_.Exception.Message)"
}
finally {
    if ($wb) { try { $wb.Close($false) | Out-Null } catch {}; Release-Com $wb }
    if ($excel) {
        try { $excel.ScreenUpdating = $true } catch {}
        try { $excel.Quit() | Out-Null } catch {}
        Release-Com $excel
    }
    if (Test-Path -LiteralPath $localPath) {
        Remove-Item -LiteralPath $localPath -Force -ErrorAction SilentlyContinue
    }
    [gc]::Collect()
    [gc]::WaitForPendingFinalizers()
}
