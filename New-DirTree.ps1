<#!
@file dir-tree.ps1
@brief Gera árvore de diretórios a partir do diretório atual, ignorando node_modules/.git/dist/.next/out.
@usage
  .\dir-tree.ps1                 # só pastas; salva em .\arquitetura.txt
  .\dir-tree.ps1 -IncludeFiles   # inclui arquivos
  .\dir-tree.ps1 -MaxDepth 5     # limita profundidade
  .\dir-tree.ps1 -OutputPath .\docs\ARVORE.md
!#>

[CmdletBinding()]
param(
    [switch]$IncludeFiles,
    [ValidateRange(0, 128)][int]$MaxDepth = 0,
    [string]$OutputPath = ".\arquitetura.txt"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Exclusões (regex)
[string[]]$ExcludePatterns = @(
    '(?i)(^|\\)node_modules(\\|$)',
    '(?i)(^|\\)\.git(\\|$)',
    '(?i)(^|\\)dist(\\|$)',
    '(?i)(^|\\)\.next(\\|$)',
    '(?i)(^|\\)out(\\|$)'
)

# Compila regex (compatível com PS 5.1)
$rxOptions = [System.Text.RegularExpressions.RegexOptions]::IgnoreCase -bor `
    [System.Text.RegularExpressions.RegexOptions]::Compiled
$compiledEx = foreach ($p in $ExcludePatterns) {
    New-Object System.Text.RegularExpressions.Regex($p, $rxOptions)
}

function Test-Excluded {
    param([Parameter(Mandatory)][string]$FullPath)
    foreach ($rx in $compiledEx) { if ($rx.IsMatch($FullPath)) { return $true } }
    return $false
}

# Raiz = diretório atual
$root = (Resolve-Path -Path .).Path

# Buffer de saída
$lines = New-Object System.Collections.Generic.List[string]
$lines.Add((Split-Path -Leaf $root))
$lines.Add('')

function Add-Tree {
    <#!
  @brief Percorre um diretório e adiciona suas entradas à árvore.
  @param Dir [string] Caminho do diretório a processar.
  @param Level [int] Nível atual (0 = raiz já impressa).
  @param Prefix [string] Prefixo visual (│/└──/├──).
  !#>
    param(
        [Parameter(Mandatory)][string]$Dir,
        [int]$Level,
        [string]$Prefix
    )

    if ($MaxDepth -gt 0 -and $Level -ge $MaxDepth) { return }

    $dirInfo = Get-Item -LiteralPath $Dir -Force
    if ($dirInfo.Attributes -band [IO.FileAttributes]::ReparsePoint) { return }

    $children = Get-ChildItem -LiteralPath $Dir -Force -ErrorAction SilentlyContinue
    $dirs = @(); $files = @()

    foreach ($c in $children) {
        if ($c.Attributes -band [IO.FileAttributes]::ReparsePoint) { continue }
        $full = $c.FullName
        if (Test-Excluded -FullPath $full) { continue }

        if ($c.PSIsContainer) { $dirs += $c }
        elseif ($IncludeFiles) { $files += $c }
    }

    $dirs = $dirs  | Sort-Object Name
    $files = $files | Sort-Object Name

    $all = @()
    $all += $dirs
    if ($IncludeFiles) { $all += $files }

    for ($i = 0; $i -lt $all.Count; $i++) {
        $isLast = ($i -eq $all.Count - 1)

        # junction (sem inline-if)
        $junction = '├── '
        if ($isLast) { $junction = '└── ' }

        $name = $all[$i].Name
        $lines.Add("$Prefix$junction$name")

        if ($all[$i].PSIsContainer) {
            # childPrefix (sem inline-if)
            $childPrefix = $Prefix
            if ($isLast) { $childPrefix += '    ' } else { $childPrefix += '│   ' }

            Add-Tree -Dir $all[$i].FullName -Level ($Level + 1) -Prefix $childPrefix
        }
    }
}

# Executa
Add-Tree -Dir $root -Level 0 -Prefix ''

# Salva
$parent = Split-Path -Parent $OutputPath
if ($parent -and -not (Test-Path $parent)) {
    New-Item -ItemType Directory -Force -Path $parent | Out-Null
}
($lines -join [Environment]::NewLine) | Out-File -FilePath $OutputPath -Encoding UTF8 -Force
Write-Host "OK: árvore gerada em $OutputPath" -ForegroundColor Green
