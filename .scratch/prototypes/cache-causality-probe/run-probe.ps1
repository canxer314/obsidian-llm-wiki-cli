$ErrorActionPreference = "Stop"

$prototypeDir = $PSScriptRoot
$outputDir = Join-Path $prototypeDir "results"
$modulePath = (Join-Path $prototypeDir "main.js").Replace("\", "/")

npm --prefix $prototypeDir run build
if ($LASTEXITCODE -ne 0) { throw "Probe build failed" }

$escapedOutput = $outputDir.Replace("\", "/").Replace("'", "\'")
$escapedModule = $modulePath.Replace("'", "\'")
$code = "(async()=>{const path='$escapedModule';delete require.cache[require.resolve(path)];const {runProbe}=require(path);const sample=app.vault.getMarkdownFiles()[0];if(!sample)throw new Error('Vault has no Markdown files');return runProbe(app,sample.constructor,'1.13.4','$escapedOutput')})()"

obsidian vault="ThinkFlywheelVault" eval code=$code
if ($LASTEXITCODE -ne 0) { throw "Probe execution failed" }

$latest = Get-ChildItem $outputDir -Directory | Sort-Object Name -Descending | Select-Object -First 1
if (-not $latest) { throw "Probe produced no result directory" }
$report = Get-Content (Join-Path $latest.FullName "report.json") -Raw | ConvertFrom-Json
if (-not $report.conclusions.boundedBarrierSupported) { throw "Probe verdict did not support the bounded barrier" }

$leftovers = obsidian vault="ThinkFlywheelVault" eval code="JSON.stringify(Array.from(app.vault.getAllLoadedFiles()).filter(f=>f.path.startsWith('__cache-causality-probe__')).map(f=>f.path))"
if ($leftovers -notmatch "\[\]") { throw "Probe left scratch paths: $leftovers" }

Write-Output (Join-Path $latest.FullName "verdict.md")
