$ErrorActionPreference = 'Stop'
$dpapiPath = 'C:\VCP\VCPToolBox\Plugin\AICodeWorker\jobs\commandcode-private-109b169bb27d\key.dpapi'
$sec = Import-Clixml -LiteralPath $dpapiPath
$bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
$apiKey = [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
[System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)

$relayBin = 'C:\VCP\VCPToolBox\Plugin\AICodeWorker\bin\codex-relay.exe'
$env:CODEX_RELAY_API_KEY = $apiKey

& $relayBin --bind 127.0.0.1 --port 31416 --upstream https://api.commandcode.ai/provider/v1 --history-store memory