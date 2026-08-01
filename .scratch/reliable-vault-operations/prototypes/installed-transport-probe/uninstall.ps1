$ErrorActionPreference = "Stop"

$target = "C:\Obsidian\ThinkFlywheelVault\.obsidian\plugins\vault-transport-probe"
$manifest = Join-Path $target "manifest.json"

if (-not (Test-Path $target)) {
    Write-Output "vault-transport-probe is not installed"
    exit 0
}
if (-not (Test-Path $manifest)) {
    throw "Unexpected directory without probe manifest: $target"
}
$manifestData = Get-Content $manifest -Raw | ConvertFrom-Json
if ($manifestData.id -ne "vault-transport-probe") {
    throw "Unexpected plugin id: $($manifestData.id)"
}

$unloadResult = obsidian vault="ThinkFlywheelVault" eval code="(async()=>{const p=app.plugins.plugins['vault-transport-probe']; if(p) p.record=()=>{}; await app.plugins.unloadPlugin('vault-transport-probe'); return {loaded:Boolean(app.plugins.plugins['vault-transport-probe']),persistentlyEnabled:app.plugins.enabledPlugins.has('vault-transport-probe')}})()"
if ($unloadResult -notmatch '"loaded": false' -or $unloadResult -notmatch '"persistentlyEnabled": false') {
    throw "Obsidian plugin unload failed: $unloadResult"
}

Write-Output "Unloaded vault-transport-probe; no listener or persistent enablement remains."
Write-Output "Static probe files remain at $target for observation capture. Remove that directory manually after reviewing probe-observations.jsonl."
