/**
 * The camera helper, as a PowerShell script. It takes one frame with Windows' own camera stack (`Windows.Media.Capture`
 * through WinRT), hands it back as base64 JPEG and exits: the camera is never left open between looks, because on a
 * laptop the indicator LED is wired to the sensor's power and nothing in software can keep it off while the sensor is up.
 * The process is started per frame on purpose.
 */
export const CAMERA_PS = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding $false
Add-Type -AssemblyName System.Runtime.WindowsRuntime, System.Drawing

function Send([string]$line) { [Console]::Out.WriteLine($line); [Console]::Out.Flush() }

function Fail([string]$message) {
  Send ((ConvertTo-Json -Compress -InputObject @{ ev = 'error'; message = $message }))
  exit 1
}

# A WinRT failure often arrives with an empty Message and only the HRESULT says what happened.
function Explain([int]$code) {
  if ($code -eq -2147024891) { return 'Access to the camera is denied: turn it on in Settings > Privacy > Camera' }
  if ($code -eq -2147023728) { return 'No camera was found' }
  if ($code -eq -1072875772) { return 'The camera is in use by another program' }
  if ($code -eq -1072873852) { return 'The camera is in use by another program' }
  if ($code -eq -1073741819) { return 'The camera driver failed' }
  return ''
}

# WinRT types are not projection-loaded in Windows PowerShell 5.1, so the async helpers the camera app uses are called by
# reflection. An action and an operation are different overloads: InitializeAsync answers with the first kind.
$asTaskOperation = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation' + [char]0x60 + '1' })[0]
$asTaskAction = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction' })[0]
if ($null -eq $asTaskOperation -or $null -eq $asTaskAction) { Fail 'This Windows cannot await camera calls: System.Runtime.WindowsRuntime is missing.' }

function AwaitAction($operation) {
  $task = $asTaskAction.Invoke($null, @($operation))
  $task.Wait(-1) | Out-Null
}

function Await($operation, $type) {
  $task = $asTaskOperation.MakeGenericMethod($type).Invoke($null, @($operation))
  $task.Wait(-1) | Out-Null
  return $task.Result
}

# One frame and out. The camera is opened, asked for a single JPEG, and shut down at once: the laptop LED is wired to
# the sensor's power, so the only way to keep it off between looks is not to hold the camera at all.
function Frame([int]$maxWidth) {
  # Type-loading the WinRT types is what makes New-Object and the property calls below resolve; a build that names the
  # assemblies differently still resolves them on first use, so a failure here is not fatal.
  try { [void][Windows.Media.Capture.MediaCapture, Windows.Media.Capture, ContentType = WindowsRuntime] } catch { }
  try { [void][Windows.Media.MediaProperties.ImageEncodingProperties, Windows.Media, ContentType = WindowsRuntime] } catch { }
  try { [void][Windows.Storage.Streams.InMemoryRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime] } catch { }

  $camera = New-Object Windows.Media.Capture.MediaCapture
  try {
    AwaitAction $camera.InitializeAsync()
    $stream = New-Object Windows.Storage.Streams.InMemoryRandomAccessStream
    AwaitAction $camera.CapturePhotoToStreamAsync([Windows.Media.MediaProperties.ImageEncodingProperties]::CreateJpeg(), $stream)
    $size = [int]$stream.Size
    if ($size -le 0) { throw 'The camera returned an empty picture.' }
    $stream.Seek(0)
    $reader = New-Object Windows.Storage.Streams.DataReader $stream.GetInputStreamAt(0)
    # LoadAsync answers with how many bytes it loaded: the awaited result is that count, not the reader.
    [void](Await $reader.LoadAsync([uint32]$size) ([uint32]))
    $bytes = New-Object byte[] $size
    $reader.ReadBytes($bytes)
    $reader.Dispose()
    $stream.Dispose()

    $memory = New-Object System.IO.MemoryStream
    $memory.Write($bytes, 0, $bytes.Length)
    $memory.Position = 0
    $image = [System.Drawing.Image]::FromStream($memory)
    $width = $image.Width
    $height = $image.Height
    # A laptop camera hands back 1920x1080 and up; the viewer is a phone screen.
    if ($maxWidth -gt 0 -and $width -gt $maxWidth) {
      $scale = $maxWidth / $width
      $smallWidth = [int][Math]::Round($width * $scale)
      $smallHeight = [int][Math]::Round($height * $scale)
      $scaled = New-Object System.Drawing.Bitmap $smallWidth, $smallHeight
      $canvas = [System.Drawing.Graphics]::FromImage($scaled)
      $canvas.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $canvas.DrawImage($image, 0, 0, $smallWidth, $smallHeight)
      $canvas.Dispose()
      $image.Dispose()
      $image = $scaled
      $width = $smallWidth
      $height = $smallHeight
      $resized = New-Object System.IO.MemoryStream
      $image.Save($resized, [System.Drawing.Imaging.ImageFormat]::Jpeg)
      $bytes = $resized.ToArray()
      $resized.Dispose()
    }
    $image.Dispose()
    $memory.Dispose()

    Send ((ConvertTo-Json -Compress -InputObject @{ ev = 'frame'; data = [Convert]::ToBase64String($bytes); width = $width; height = $height; mime = 'image/jpeg' }))
  } finally {
    try { $camera.Dispose() } catch { }
  }
}

Send '{"ev":"ready"}'
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $line = $line.Trim()
  if ($line.Length -eq 0) { continue }
  try {
    $op = ConvertFrom-Json -InputObject $line
    if ($op.op -eq 'quit') { break }
    if ($op.op -ne 'capture') { continue }
    $max = 1280
    if ($null -ne $op.maxWidth) { $max = [int]$op.maxWidth }
    Frame $max
  } catch {
    $e = $_.Exception
    while ($e.InnerException) { $e = $e.InnerException }
    $code = 0
    try { $code = [int]$e.HResult } catch { }
    $text = [string]$e.Message
    if ([string]::IsNullOrWhiteSpace($text)) { $text = [string]$e.GetType().FullName }
    $hint = Explain $code
    if ($hint.Length -gt 0) { $text = $hint }
    if ($code -ne 0) { $text = $text + ' [' + ('{0:X8}' -f $code) + ']' }
    Fail $text
  }
}
`;

/** Windows PowerShell 5.1 reads a BOM-less script in the ANSI code page; the BOM keeps any Cyrillic intact. */
export const CAMERA_PS_FILE = '﻿' + CAMERA_PS;
