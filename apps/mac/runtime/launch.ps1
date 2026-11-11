param([string]$ConfigPath=(Join-Path (Split-Path $PSScriptRoot) 'installation.json'))
$ErrorActionPreference='Stop'
$config=Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8|ConvertFrom-Json
Start-Process -FilePath $config.nodePath -WindowStyle Hidden -ArgumentList @(('"'+(Join-Path $PSScriptRoot 'windows-launch.mjs')+'"'),('"'+$ConfigPath+'"'))
