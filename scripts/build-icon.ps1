$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$root = Split-Path -Parent $PSScriptRoot
$vendor = Join-Path $root 'vendor'
New-Item -ItemType Directory -Path $vendor -Force | Out-Null
$bitmap = New-Object System.Drawing.Bitmap 256,256
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
$shape = New-Object System.Drawing.Drawing2D.GraphicsPath
$shape.AddArc(8,8,64,64,180,90)
$shape.AddArc(184,8,64,64,270,90)
$shape.AddArc(184,184,64,64,0,90)
$shape.AddArc(8,184,64,64,90,90)
$shape.CloseFigure()
$brush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(15,108,189))
$graphics.FillPath($brush,$shape)
$font = New-Object System.Drawing.Font 'Segoe UI',92,([System.Drawing.FontStyle]::Bold),([System.Drawing.GraphicsUnit]::Pixel)
$format = New-Object System.Drawing.StringFormat
$format.Alignment = [System.Drawing.StringAlignment]::Center
$format.LineAlignment = [System.Drawing.StringAlignment]::Center
$graphics.DrawString('OF',$font,[System.Drawing.Brushes]::White,(New-Object System.Drawing.RectangleF 0,0,256,256),$format)
$png = New-Object System.IO.MemoryStream
$bitmap.Save($png,[System.Drawing.Imaging.ImageFormat]::Png)
$bytes = $png.ToArray()
$iconStream = [System.IO.File]::Create((Join-Path $vendor 'OfficeFlow.ico'))
$writer = New-Object System.IO.BinaryWriter $iconStream
$writer.Write([uint16]0)
$writer.Write([uint16]1)
$writer.Write([uint16]1)
$writer.Write([byte]0)
$writer.Write([byte]0)
$writer.Write([byte]0)
$writer.Write([byte]0)
$writer.Write([uint16]1)
$writer.Write([uint16]32)
$writer.Write([uint32]$bytes.Length)
$writer.Write([uint32]22)
$writer.Write($bytes)
$writer.Dispose()
$bitmap.Save((Join-Path $vendor 'icon-preview.png'),[System.Drawing.Imaging.ImageFormat]::Png)
$png.Dispose()
$format.Dispose()
$font.Dispose()
$brush.Dispose()
$shape.Dispose()
$graphics.Dispose()
$bitmap.Dispose()
Write-Output 'OfficeFlow icon generated.'
