param([string]$ConfigPath=(Join-Path (Split-Path $PSScriptRoot) 'installation.json'))
$ErrorActionPreference='Stop'
$config=Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8|ConvertFrom-Json
$env:NODE_USE_ENV_PROXY='1'
$env:NO_PROXY=(@($env:NO_PROXY,'127.0.0.1','localhost','::1') -join ',')
Start-Process -FilePath $config.nodePath -WindowStyle Hidden -ArgumentList @(('"'+(Join-Path $PSScriptRoot 'windows-launch.mjs')+'"'),('"'+$ConfigPath+'"'))
