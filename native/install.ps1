param(
    [Parameter(Mandatory=$true)][ValidatePattern('^[a-p]{32}$')][string]$ExtensionId,
    [string]$PythonPath = 'python'
)
$ErrorActionPreference = 'Stop'
$pythonExe = (Get-Command $PythonPath -ErrorAction Stop).Source
& $pythonExe -c 'import yt_dlp' 2>$null
if ($LASTEXITCODE -ne 0) { throw '먼저 Python에 yt-dlp[default]를 설치하세요. README.md를 확인하세요.' }
$launcher = Join-Path $PSScriptRoot 'launch.cmd'
@"
@echo off
"$pythonExe" "$PSScriptRoot\host.py" %*
"@ | Set-Content -LiteralPath $launcher -Encoding Default
$manifestPath = Join-Path $PSScriptRoot 'com.media_downloader.helper.json'
@{
    name = 'com.media_downloader.helper'
    description = 'Media Downloader yt-dlp helper'
    path = $launcher
    type = 'stdio'
    allowed_origins = @("chrome-extension://$ExtensionId/")
} | ConvertTo-Json | ForEach-Object { [System.IO.File]::WriteAllText($manifestPath, $_, (New-Object System.Text.UTF8Encoding($false))) }
$key = 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.media_downloader.helper'
New-Item -Path $key -Force | Out-Null
Set-Item -Path $key -Value $manifestPath
Write-Host '등록 완료. Chrome을 다시 시작하고 보조 프로그램 연결 확인을 누르세요.'
