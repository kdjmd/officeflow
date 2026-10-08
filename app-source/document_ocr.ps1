param(
    [Parameter(Mandatory = $true)]
    [string]$InputFile,
    [string]$Language = "zh-CN"
)

$ErrorActionPreference = "Stop"
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)

function Write-JsonResult {
    param([object]$Value)
    [Console]::Out.WriteLine(($Value | ConvertTo-Json -Depth 8 -Compress))
}

$stream = $null
$bitmap = $null

try {
    $absolutePath = [System.IO.Path]::GetFullPath($InputFile)
    if (-not [System.IO.File]::Exists($absolutePath)) {
        throw "Input image does not exist."
    }
    if ([System.IO.Path]::GetExtension($absolutePath).ToLowerInvariant() -ne ".png") {
        throw "Only PNG input is supported."
    }

    Add-Type -AssemblyName System.Runtime.WindowsRuntime
    [void][Windows.Media.Ocr.OcrEngine,Windows.Media.Ocr,ContentType=WindowsRuntime]
    [void][Windows.Graphics.Imaging.SoftwareBitmap,Windows.Graphics.Imaging,ContentType=WindowsRuntime]
    [void][Windows.Graphics.Imaging.BitmapDecoder,Windows.Graphics.Imaging,ContentType=WindowsRuntime]
    [void][Windows.Globalization.Language,Windows.Globalization,ContentType=WindowsRuntime]
    [void][Windows.Storage.StorageFile,Windows.Storage,ContentType=WindowsRuntime]

    $asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
        $_.Name -eq "AsTask" -and
        $_.IsGenericMethod -and
        $_.GetGenericArguments().Count -eq 1 -and
        $_.GetParameters().Count -eq 1 -and
        $_.ReturnType.IsGenericType
    })[0]

    function Await-WinRt {
        param($Operation, [Type]$ResultType)
        $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
        $task = $asTask.Invoke($null, @($Operation))
        if (-not $task.Wait(30000)) {
            throw "Windows OCR operation timed out."
        }
        return $task.Result
    }

    $requestedLanguage = [Windows.Globalization.Language]::new($Language)
    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($requestedLanguage)
    if (-not $engine) {
        $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
    }
    if (-not $engine) {
        Write-JsonResult ([ordered]@{
            success = $false
            error = [ordered]@{
                code = "OCR_ENGINE_UNAVAILABLE"
                message = "Windows OCR language pack is unavailable."
            }
        })
        exit 3
    }

    $storageFile = Await-WinRt ([Windows.Storage.StorageFile]::GetFileFromPathAsync($absolutePath)) ([Windows.Storage.StorageFile])
    $stream = Await-WinRt ($storageFile.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
    $decoder = Await-WinRt ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $bitmap = Await-WinRt ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])

    if ($bitmap.PixelWidth -gt [Windows.Media.Ocr.OcrEngine]::MaxImageDimension -or
        $bitmap.PixelHeight -gt [Windows.Media.Ocr.OcrEngine]::MaxImageDimension) {
        throw "Input image exceeds the Windows OCR dimension limit."
    }

    $ocrResult = Await-WinRt ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
    $lines = @()
    foreach ($line in $ocrResult.Lines) {
        $words = @()
        $left = [double]::PositiveInfinity
        $top = [double]::PositiveInfinity
        $right = 0.0
        $bottom = 0.0
        foreach ($word in $line.Words) {
            $rect = $word.BoundingRect
            $left = [Math]::Min($left, $rect.X)
            $top = [Math]::Min($top, $rect.Y)
            $right = [Math]::Max($right, $rect.X + $rect.Width)
            $bottom = [Math]::Max($bottom, $rect.Y + $rect.Height)
            $words += [ordered]@{
                text = $word.Text
                bbox = [ordered]@{
                    x = [Math]::Round($rect.X, 2)
                    y = [Math]::Round($rect.Y, 2)
                    width = [Math]::Round($rect.Width, 2)
                    height = [Math]::Round($rect.Height, 2)
                }
            }
        }
        $lineBox = $null
        if ($words.Count -gt 0) {
            $lineBox = [ordered]@{
                x = [Math]::Round($left, 2)
                y = [Math]::Round($top, 2)
                width = [Math]::Round($right - $left, 2)
                height = [Math]::Round($bottom - $top, 2)
            }
        }
        $lines += [ordered]@{
            text = $line.Text
            bbox = $lineBox
            words = $words
        }
    }

    Write-JsonResult ([ordered]@{
        success = $true
        language = $engine.RecognizerLanguage.LanguageTag
        imageWidth = $bitmap.PixelWidth
        imageHeight = $bitmap.PixelHeight
        text = $ocrResult.Text
        lines = $lines
    })
    exit 0
}
catch {
    Write-JsonResult ([ordered]@{
        success = $false
        error = [ordered]@{
            code = "OCR_FAILED"
            message = $_.Exception.Message
        }
    })
    exit 1
}
finally {
    if ($bitmap -and $bitmap -is [System.IDisposable]) {
        $bitmap.Dispose()
    }
    if ($stream -and $stream -is [System.IDisposable]) {
        $stream.Dispose()
    }
}
