$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
[Console]::InputEncoding=[Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
try {
  Add-Type -AssemblyName System.Security
  $request=[Console]::In.ReadToEnd() | ConvertFrom-Json
  if(!$request.key -or $request.key.Length -gt 4096){throw 'Invalid key'}
  $entropy=[Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes('UsageLedger-v2|'+$request.key))
  if($request.action -eq 'protect'){
    $plain=[Text.Encoding]::UTF8.GetBytes(($request.value | ConvertTo-Json -Compress -Depth 8))
    try {$protected=[Security.Cryptography.ProtectedData]::Protect($plain,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)} finally {[Array]::Clear($plain,0,$plain.Length)}
    [Console]::Out.Write((@{blob=[Convert]::ToBase64String($protected)} | ConvertTo-Json -Compress))
  } elseif($request.action -eq 'unprotect') {
    $plain=[Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($request.blob),$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)
    try {[Console]::Out.Write('{"value":'+[Text.Encoding]::UTF8.GetString($plain)+'}')} finally {[Array]::Clear($plain,0,$plain.Length)}
  } else {throw 'Unknown action'}
} catch {[Console]::Error.Write('CREDENTIAL_STORE_UNAVAILABLE');exit 1}
