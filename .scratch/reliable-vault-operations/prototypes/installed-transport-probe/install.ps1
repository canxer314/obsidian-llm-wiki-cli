$ErrorActionPreference = "Stop"

$source = $PSScriptRoot
$target = "C:\Obsidian\ThinkFlywheelVault\.obsidian\plugins\vault-transport-probe"
$manifest = Join-Path $source "manifest.json"

if (-not (Test-Path $manifest)) {
    throw "Prototype manifest not found: $manifest"
}

$manifestData = Get-Content $manifest -Raw | ConvertFrom-Json
if ($manifestData.id -ne "vault-transport-probe") {
    throw "Refusing to install unexpected plugin id: $($manifestData.id)"
}

if (Test-Path $target) {
    $installedManifest = Join-Path $target "manifest.json"
    if (-not (Test-Path $installedManifest) -or (Get-Content $installedManifest -Raw | ConvertFrom-Json).id -ne "vault-transport-probe") {
        throw "Refusing to overwrite unexpected directory: $target"
    }
} else {
    New-Item -ItemType Directory -Path $target | Out-Null
}

Copy-Item (Join-Path $source "manifest.json") $target -Force
Copy-Item (Join-Path $source "main.js") $target -Force

$loadResult = obsidian vault="ThinkFlywheelVault" eval code="(async()=>{await app.plugins.loadManifests(); if(!app.plugins.manifests['vault-transport-probe']) throw new Error('probe manifest not found'); await app.plugins.unloadPlugin('vault-transport-probe'); await app.plugins.loadPlugin('vault-transport-probe'); const p=app.plugins.plugins['vault-transport-probe']; return {loaded:Boolean(p),listening:Boolean(p?.server?.listening),address:p?.server?.address?.()}})()"
if ($loadResult -notmatch '"loaded": true' -or $loadResult -notmatch '"listening": true') {
    throw "Obsidian probe load failed: $loadResult"
}
$errors = obsidian vault="ThinkFlywheelVault" dev:errors
if ($errors -notmatch "No errors captured") { throw "Obsidian reported errors: $errors" }

$configPath = Join-Path $env:CLAUDE_JOB_DIR "tmp\vault-transport-probe.mcp.json"
@{
    mcpServers = @{
        vault_transport_probe = @{
            type = "http"
            url = "http://127.0.0.1:27124/mcp"
            timeout = 60000
        }
    }
} | ConvertTo-Json -Depth 5 | Set-Content $configPath -Encoding utf8NoBOM

Write-Output "Installed vault-transport-probe and wrote $configPath"
Write-Output "Use: claude -p --strict-mcp-config --mcp-config `"$configPath`" --permission-mode bypassPermissions --output-format json `<prompt`>"
