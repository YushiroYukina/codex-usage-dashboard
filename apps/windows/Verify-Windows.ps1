param([string]$ConfigPath=(Join-Path $PSScriptRoot 'installation.json'),[string]$Output,[switch]$ShowAccountScope)
$ErrorActionPreference='Stop'
$config=Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8|ConvertFrom-Json
$argsList=@((Join-Path $PSScriptRoot 'runtime\windows-check.mjs'),'--config',$ConfigPath)
if($Output){$argsList+=@('--output',$Output)}
if($ShowAccountScope){$argsList+='--show-account-scope'}
& $config.nodePath @argsList
exit $LASTEXITCODE
