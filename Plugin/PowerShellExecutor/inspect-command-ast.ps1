# Trusted parser helper. STDIN is JSON data; submitted commands are NEVER executed.
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

try {
    $request = ConvertFrom-Json -InputObject ([Console]::In.ReadToEnd())
    if ($null -eq $request.commands) { throw 'INPUT_SCHEMA' }
    $aliases = @{}
    foreach ($alias in @(Get-Alias)) {
        $aliases[$alias.Name.ToLowerInvariant()] = $alias.Definition
    }
    $results = New-Object 'System.Collections.Generic.List[object]'
    foreach ($source in @($request.commands)) {
        if ($source -isnot [string]) { throw 'INPUT_SCHEMA' }
        $tokens = $null
        $parseErrors = $null
        $ast = [System.Management.Automation.Language.Parser]::ParseInput(
            $source, [ref]$tokens, [ref]$parseErrors
        )
        $errors = @($parseErrors | ForEach-Object {
            [pscustomobject]@{
                errorId = $_.ErrorId
                line = $_.Extent.StartLineNumber
                column = $_.Extent.StartColumnNumber
            }
        })
        $facts = New-Object 'System.Collections.Generic.List[object]'
        $nodes = $ast.FindAll({
            param($n)
            ($n -is [System.Management.Automation.Language.CommandAst]) -or
            ($n -is [System.Management.Automation.Language.FileRedirectionAst]) -or
            ($n -is [System.Management.Automation.Language.InvokeMemberExpressionAst]) -or
            ($n -is [System.Management.Automation.Language.UsingStatementAst])
        }, $true)

        foreach ($node in $nodes) {
            $line = $node.Extent.StartLineNumber
            $column = $node.Extent.StartColumnNumber
            if ($node -is [System.Management.Automation.Language.CommandAst]) {
                $name = $node.GetCommandName()
                $inline = ($node.CommandElements.Count -gt 0) -and
                    ($node.CommandElements[0] -is [System.Management.Automation.Language.ScriptBlockExpressionAst])
                $resolved = [string]$name
                $seen = @{}
                while ($resolved -and $aliases.ContainsKey($resolved.ToLowerInvariant())) {
                    $key = $resolved.ToLowerInvariant()
                    if ($seen.ContainsKey($key)) { break }
                    $seen[$key] = $true
                    $resolved = [string]$aliases[$key]
                }
                # Return flags rather than argument text: arguments may contain secrets.
                $providerReference = $false
                $automationType = $false
                foreach ($element in $node.CommandElements) {
                    if ($element -is [System.Management.Automation.Language.StringConstantExpressionAst]) {
                        if ($element.Value -match '^(alias|function):') { $providerReference = $true }
                        if ($element.Value -match '^(System\.Management\.Automation\.)?(PowerShell|ScriptBlock)$') {
                            $automationType = $true
                        }
                    }
                }
                $facts.Add([pscustomobject]@{
                    kind = 'command'
                    name = [string]$name
                    resolved = $resolved
                    inlineBlock = [bool]$inline
                    dotSource = ([string]$node.InvocationOperator -eq 'Dot')
                    providerReference = $providerReference
                    automationType = $automationType
                    line = $line
                    column = $column
                })
            } elseif ($node -is [System.Management.Automation.Language.FileRedirectionAst]) {
                $facts.Add([pscustomobject]@{
                    kind = 'redirect'
                    append = [bool]$node.Append
                    line = $line
                    column = $column
                })
            } elseif ($node -is [System.Management.Automation.Language.InvokeMemberExpressionAst]) {
                $member = ''
                if ($node.Member -is [System.Management.Automation.Language.StringConstantExpressionAst]) {
                    $member = $node.Member.Value
                }
                $typeName = ''
                if ($node.Expression -is [System.Management.Automation.Language.TypeExpressionAst]) {
                    $typeName = $node.Expression.TypeName.FullName
                }
                $facts.Add([pscustomobject]@{
                    kind = 'method'
                    member = [string]$member
                    typeName = [string]$typeName
                    line = $line
                    column = $column
                })
            } else {
                $facts.Add([pscustomobject]@{
                    kind = 'using'
                    usingKind = [string]$node.UsingStatementKind
                    line = $line
                    column = $column
                })
            }
        }
        $results.Add([pscustomobject]@{ errors = $errors; facts = $facts.ToArray() })
    }
    $response = [pscustomobject]@{ version = 1; results = $results.ToArray() }
    [Console]::Out.Write((ConvertTo-Json -InputObject $response -Depth 10 -Compress))
} catch {
    # Do not return submitted source, parser exception text, or environment values.
    [Console]::Error.WriteLine('AST_HELPER_FAILURE')
    exit 1
}