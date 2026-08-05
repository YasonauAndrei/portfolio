param(
  [string]$ChromePath = "",
  [int]$Width = 320,
  [int]$Height = 640,
  [int]$WaitMs = 30000,
  [string[]]$Ids = @(),
  [switch]$Force
)

$ErrorActionPreference = "Stop"

$argsList = @(
  (Join-Path $PSScriptRoot "generate-previews.mjs"),
  "--width=$Width",
  "--height=$Height",
  "--wait-ms=$WaitMs"
)

if ($ChromePath) { $argsList += "--chrome-path=$ChromePath" }
if ($Ids.Count -gt 0) { $argsList += "--ids=$($Ids -join ',')" }
if ($Force) { $argsList += "--force" }

node @argsList
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
