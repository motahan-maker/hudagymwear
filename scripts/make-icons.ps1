# Generates PWA app icons for HUDA GYMWEAR Brand Studio.
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/make-icons.ps1
Add-Type -AssemblyName System.Drawing

$burgundy = [System.Drawing.Color]::FromArgb(255, 109, 31, 44)   # --burgundy
$cream    = [System.Drawing.Color]::FromArgb(255, 255, 252, 248)

function Draw-CenteredText($g, $text, $family, $emSize, [float]$y, [float]$size, [single]$tracking, $color) {
  $font = New-Object System.Drawing.Font($family, $emSize, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
  $brush = New-Object System.Drawing.SolidBrush($color)
  if ($tracking -le 0) {
    $sf = New-Object System.Drawing.StringFormat
    $sf.Alignment = [System.Drawing.StringAlignment]::Center
    $sf.LineAlignment = [System.Drawing.StringAlignment]::Near
    $g.DrawString($text, $font, $brush, [float]($size / 2), [float]$y, $sf)
    $sf.Dispose()
  } else {
    # manual letter-spacing: measure each glyph, draw centred as a run
    $widths = @(); $total = 0.0
    foreach ($ch in $text.ToCharArray()) {
      $w = $g.MeasureString([string]$ch, $font).Width
      $widths += $w; $total += $w + $tracking
    }
    $total -= $tracking
    $x = [float](($size - $total) / 2)
    $i = 0
    foreach ($ch in $text.ToCharArray()) {
      $g.DrawString([string]$ch, $font, $brush, $x, [float]$y)
      $x += $widths[$i] + $tracking; $i++
    }
  }
  $brush.Dispose(); $font.Dispose()
}

function Draw-Barbell($g, [float]$size, [float]$y, $color) {
  $pen = New-Object System.Drawing.Pen($color, [Math]::Max(2, $size * 0.008))
  $brush = New-Object System.Drawing.SolidBrush($color)
  $cx = $size / 2
  $half = $size * 0.11
  $g.DrawLine($pen, [float]($cx - $half), [float]$y, [float]($cx + $half), [float]$y)
  $w = $size * 0.022; $h = $size * 0.055
  foreach ($dx in @(-$half, $half)) {
    $g.FillRectangle($brush, [float]($cx + $dx - $w/2), [float]($y - $h/2), [float]$w, [float]$h)
  }
  $pen.Dispose(); $brush.Dispose()
}

function Render-Logo([int]$size, [double]$scale) {
  $bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAlias
  $bg = New-Object System.Drawing.SolidBrush($burgundy)
  $g.FillRectangle($bg, 0, 0, $size, $size)
  $bg.Dispose()

  $offset = ($size * (1 - $scale)) / 2   # maskable safe-zone shift

  if ($scale -ge 1.0) {
    $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(110, 255, 252, 248), [Math]::Max(2, $size * 0.006))
    $m = $size * 0.06
    $g.DrawRectangle($pen, [float]$m, [float]$m, [float]($size - 2 * $m), [float]($size - 2 * $m))
    $pen.Dispose()
  }

  # "H" monogram (Georgia serif — close cousin of the brand's Cormorant)
  Draw-CenteredText $g "H" "Georgia" ($size * 0.40 * $scale) ($offset + 0.13 * $size * $scale) $size 0 $cream
  Draw-CenteredText $g "HUDA" "Georgia" ($size * 0.115 * $scale) ($offset + 0.585 * $size * $scale) $size ($size * 0.030 * $scale) $cream
  Draw-CenteredText $g "GYMWEAR" "Segoe UI" ($size * 0.046 * $scale) ($offset + 0.735 * $size * $scale) $size ($size * 0.026 * $scale) ([System.Drawing.Color]::White)
  Draw-Barbell $g $size ([float]($offset + 0.845 * $size * $scale)) $cream

  $g.Dispose()
  return $bmp
}

function Save($bmp, $path) {
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Write-Output "saved $path"
}

$outDir = Join-Path $PSScriptRoot "..\public\icons"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

Save (Render-Logo 512 1.0) (Join-Path $outDir "icon-512.png")
Save (Render-Logo 192 1.0) (Join-Path $outDir "icon-192.png")
Save (Render-Logo 180 1.0) (Join-Path $outDir "apple-touch-icon.png")
Save (Render-Logo 512 0.72) (Join-Path $outDir "maskable-512.png")
Save (Render-Logo 192 0.72) (Join-Path $outDir "maskable-192.png")
