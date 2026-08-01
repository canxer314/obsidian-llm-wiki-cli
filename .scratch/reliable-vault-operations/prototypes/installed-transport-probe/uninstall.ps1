$ErrorActionPreference = "Stop"

$target = "C:\Obsidian\ThinkFlywheelVault\.obsidian\plugins\vault-transport-probe"
$manifest = Join-Path $target "manifest.json"

if (-not (Test-Path $target)) {
    Write-Output "vault-transport-probe is not installed"
    exit 0
}
if (-not (Test-Path $manifest)) {
    throw "Refusing to remove directory without manifest: $target"
}
$manifestData = Get-Content $manifest -Raw | ConvertFrom-Json
if ($manifestData.id -ne "vault-transport-probe") {
    throw "Refusing to remove unexpected plugin id: $($manifestData.id)"
}

try {
    $unloadResult = obsidian vault="ThinkFlywheelVault" eval code="(async()=>{const p=app.plugins.plugins['vault-transport-probe']; if(p) p.record=()=>{}; await app.plugins.unloadPlugin('vault-transport-probe'); return {loaded:Boolean(app.plugins.plugins['vault-transport-probe'])}})()"
    if ($unloadResult -notmatch '"loaded": false') { throw "Obsidian plugin unload failed: $unloadResult" }
} finally {
    Remove-Item $target -Recurse -Force -Confirm:$false
}

Write-Output "Disabled and removed installed vault-transport-probe"
