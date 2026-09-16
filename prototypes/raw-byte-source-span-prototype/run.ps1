$ErrorActionPreference = 'Stop'

$vault = 'ThinkFlywheelVault'
$fixtureDir = 'C:\Obsidian\ThinkFlywheelVault\__WAYFINDER_RAW_BYTE_PROTOTYPE__'
$scriptPath = Join-Path $PSScriptRoot 'validation-eval.js'

if (Test-Path $fixtureDir) { throw "Refusing to overwrite existing fixture directory: $fixtureDir" }

try {
    $code = Get-Content $scriptPath -Raw
    $output = obsidian vault=$vault eval code=$code
    $output
    if ($LASTEXITCODE -ne 0) { throw "Obsidian eval exited with $LASTEXITCODE" }
    $joinedOutput = $output -join [Environment]::NewLine
    $joinedOutput | Set-Content (Join-Path $PSScriptRoot 'last-result.txt')
    if ($joinedOutput -notmatch '"passed"\s*:\s*true') { throw 'Raw-byte source-span validation failed' }
}
finally {
    if (Test-Path $fixtureDir) {
        try { obsidian vault=$vault delete path="__WAYFINDER_RAW_BYTE_PROTOTYPE__/source.md" | Out-Null } catch {}
        try { obsidian vault=$vault delete path="__WAYFINDER_RAW_BYTE_PROTOTYPE__/last-result.json" | Out-Null } catch {}
        if ((Get-ChildItem $fixtureDir | Measure-Object).Count -eq 0) {
            Remove-Item 'C:\Obsidian\ThinkFlywheelVault\__WAYFINDER_RAW_BYTE_PROTOTYPE__' -Confirm:$false
        }
    }
}
