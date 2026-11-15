param(
    [ValidatePattern('^[a-p]{32}$')][string]$ExtensionId,
    [string]$PythonPath = '',
    [switch]$UpdateDependencies
)
$ErrorActionPreference = 'Stop'
$projectPath = [IO.Path]::GetFullPath((Split-Path $PSScriptRoot -Parent)).TrimEnd('\')
if (-not $ExtensionId) {
    $ids = @()
    $profileRoot = Join-Path $env:LOCALAPPDATA 'Google\Chrome\User Data'
    foreach ($profile in Get-ChildItem -LiteralPath $profileRoot -Directory -ErrorAction SilentlyContinue) {
        foreach ($name in @('Secure Preferences', 'Preferences')) {
            $preferencesPath = Join-Path $profile.FullName $name
            if (-not (Test-Path -LiteralPath $preferencesPath)) { continue }
            try {
                $preferences = Get-Content -LiteralPath $preferencesPath -Raw -Encoding UTF8 | ConvertFrom-Json
                foreach ($entry in $preferences.extensions.settings.PSObject.Properties) {
                    if ($entry.Value.path -and [IO.Path]::IsPathRooted($entry.Value.path) -and
                        [IO.Path]::GetFullPath($entry.Value.path).TrimEnd('\') -eq $projectPath) {
                        $ids += $entry.Name
                    }
                }
            } catch { Write-Verbose "Cannot read $preferencesPath" }
        }
    }
    $ids = @($ids | Sort-Object -Unique)
    if ($ids.Count -ne 1) { throw 'Load this folder in chrome://extensions first, or supply -ExtensionId with its ID.' }
    $ExtensionId = $ids[0]
}
if ($ExtensionId -notmatch '^[a-p]{32}$') { throw 'Invalid extension ID.' }
if (-not $PythonPath) {
    $localPython = Join-Path $PSScriptRoot '.venv\Scripts\python.exe'
    if (-not (Test-Path -LiteralPath $localPython)) {
        & python -m venv (Join-Path $PSScriptRoot '.venv')
        if ($LASTEXITCODE -ne 0) { throw 'Python 3.10+ is required.' }
    }
    $PythonPath = $localPython
}
$pythonExe = (Get-Command $PythonPath -ErrorAction Stop).Source
& $pythonExe -c "import importlib.util, sys; sys.exit(0 if all(importlib.util.find_spec(name) is not None for name in ('yt_dlp', 'yt_dlp_ejs')) else 1)"
if ($LASTEXITCODE -ne 0 -or $UpdateDependencies) {
    & $pythonExe -m pip install --disable-pip-version-check -U 'yt-dlp[default]'
    if ($LASTEXITCODE -ne 0) { throw 'Could not install yt-dlp[default]. Check your network and Python version.' }
}
# Chrome may have been started before tools were added to PATH.
$toolDirs = @('ffmpeg', 'ffprobe', 'node', 'deno') | ForEach-Object {
    $tool = Get-Command $_ -ErrorAction SilentlyContinue
    if ($tool) { Split-Path $tool.Source -Parent }
} | Sort-Object -Unique
@{ toolDirectories = @($toolDirs) } | ConvertTo-Json | ForEach-Object {
    [IO.File]::WriteAllText((Join-Path $PSScriptRoot 'helper_config.json'), $_, (New-Object Text.UTF8Encoding($false)))
}
$launcher = Join-Path $PSScriptRoot 'launch.cmd'
@"
@echo off
"$pythonExe" -u "$PSScriptRoot\host.py" %*
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
Write-Host "Helper connected to extension $ExtensionId. Reload the extension and check its connection."
