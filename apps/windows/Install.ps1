param([string]$InstallDir,[string]$DataDir,[string]$CodexHome,[string]$NodePath,[string]$CodexPath,[string]$ServiceOrigin,[switch]$RegisterPlugin,[switch]$NoShortcut)
$ErrorActionPreference='Stop'
$edition=Get-Content (Join-Path $PSScriptRoot 'edition.json') -Raw|ConvertFrom-Json
$single=$edition.mode-eq 'single'
if(!$InstallDir){$InstallDir=Join-Path $env:LOCALAPPDATA ('Programs\UsageLedgerV2\0.5.0-rc.2'+$(if($single){'-single'}else{''}))}
if(!$DataDir){$DataDir=Join-Path $env:LOCALAPPDATA $(if($single){'UsageLedgerSingle\state'}else{'UsageLedgerV2\state'})}

if(!$CodexHome){$CodexHome=if($env:CODEX_HOME){$env:CODEX_HOME}else{Join-Path $env:USERPROFILE '.codex'}}
if(!$NodePath){$paths=@((Get-Command node.exe -ErrorAction SilentlyContinue).Source);foreach($p in @(Get-AppxPackage '*CodexPrimaryRuntime*' -ErrorAction SilentlyContinue)){$paths+=Join-Path $p.InstallLocation 'dependencies\node\bin\node.exe'};foreach($candidate in $paths){if($candidate -and (Test-Path -LiteralPath $candidate)){try{if([int](& $candidate -p 'parseInt(process.versions.node)') -ge 24){$NodePath=$candidate;break}}catch{}}}}
if(!$NodePath -or [int](& $NodePath -p 'parseInt(process.versions.node)') -lt 24){throw '需要 Node.js 24 或更高版本。'}
if(!$CodexPath){foreach($p in @(Get-AppxPackage 'OpenAI.Codex' -ErrorAction SilentlyContinue)){$candidate=Join-Path $p.InstallLocation 'app\resources\codex.exe';if(Test-Path -LiteralPath $candidate){$CodexPath=$candidate;break}}}
if(!$CodexPath -or !(Test-Path -LiteralPath $CodexPath)){throw '未找到 Codex；请用 -CodexPath 指定程序。'}
$InstallDir=[IO.Path]::GetFullPath($InstallDir);$DataDir=[IO.Path]::GetFullPath($DataDir);$CodexHome=[IO.Path]::GetFullPath($CodexHome)
if($InstallDir -match 'GPT-Niang|gpt-niang' -or $DataDir -match 'GPTNiangUsage' -or $InstallDir-eq $DataDir -or $DataDir-eq $CodexHome){throw '请选择独立的程序与数据目录。'}
if(Test-Path -LiteralPath (Join-Path $InstallDir 'installation.json')){throw '目标已有安装；未覆盖，请选择新目录。'}
if($single -and $ServiceOrigin){throw '单设备版不提供账号同步服务配置。'}
if($ServiceOrigin){$validated=& $NodePath (Join-Path $PSScriptRoot 'runtime\validate-service.mjs') $ServiceOrigin;if($LASTEXITCODE-ne 0){throw '服务地址无效，须使用 HTTPS。'};$ServiceOrigin=$validated}
[void][IO.Directory]::CreateDirectory($InstallDir);[void][IO.Directory]::CreateDirectory($DataDir)
if($InstallDir-ne $PSScriptRoot){Get-ChildItem -LiteralPath $PSScriptRoot -Force|Where-Object Name -NotIn @('installation.json','SOURCE-SHA256.json')|Copy-Item -Destination $InstallDir -Recurse -Force}
& $NodePath (Join-Path $InstallDir 'runtime\backup-ledger.mjs') $DataDir
if($LASTEXITCODE-ne 0){throw '账本备份未完成，安装已停止。'}
$config=@{version='0.5.0-rc.2';syncMode=$edition.mode;nodePath=$NodePath;codexPath=$CodexPath;codexHome=$CodexHome;dataDir=$DataDir;historyTurnUsage=$true;nativeUsage=$true;accountSync=$true;crossDeviceSync=$false;pairedSync=(!$single);syncRoot=(Join-Path $DataDir 'legacy-sync')}
[IO.File]::WriteAllText((Join-Path $InstallDir 'installation.json'),($config|ConvertTo-Json),[Text.UTF8Encoding]::new($false))
[IO.File]::WriteAllText((Join-Path $InstallDir '.mcp.json'),(@{mcpServers=@{usage_ledger=@{command=$NodePath;args=@((Join-Path $InstallDir 'runtime\mcp.mjs'))}}}|ConvertTo-Json -Depth 6),[Text.UTF8Encoding]::new($false))
if($single -and $ServiceOrigin){throw '单设备版不提供账号同步服务配置。'}
if($ServiceOrigin){[IO.File]::WriteAllText((Join-Path $DataDir 'account-sync.json'),(@{service=$ServiceOrigin;enabled=$false}|ConvertTo-Json),[Text.UTF8Encoding]::new($false))}
if(!$NoShortcut){$shell=New-Object -ComObject WScript.Shell;$link=$shell.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Desktop')) $(if($single){'Codex 用量看板 单设备版.lnk'}else{'Codex 用量看板 同步版.lnk'})));$link.TargetPath=Join-Path $env:WINDIR 'System32\wscript.exe';$link.Arguments='"'+(Join-Path $InstallDir 'launch.vbs')+'"';$link.WorkingDirectory=$InstallDir;$link.IconLocation=Join-Path $InstallDir 'assets\icon.ico';$link.Save()}
if($RegisterPlugin){$market=Split-Path $InstallDir;$meta=Join-Path $market '.agents\plugins';[void][IO.Directory]::CreateDirectory($meta);$doc=@{name='usage-ledger-v2-local';plugins=@(@{name='usage-ledger';source=@{source='local';path=('./'+(Split-Path $InstallDir -Leaf))};policy=@{installation='AVAILABLE';authentication='ON_INSTALL'};category='Productivity'})};[IO.File]::WriteAllText((Join-Path $meta 'marketplace.json'),($doc|ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false));& $CodexPath plugin marketplace add $market --json;if($LASTEXITCODE-ne 0){throw '桌面应用已安装，插件市场注册未完成。'};& $CodexPath plugin add 'usage-ledger@usage-ledger-v2-local' --json;if($LASTEXITCODE-ne 0){throw '桌面应用已安装，插件注册未完成。'}}
Write-Output ('Installed: '+$InstallDir)
