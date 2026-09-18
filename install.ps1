<#
rig in one command: clone the tool, install it globally, and prove it runs.

  irm https://raw.githubusercontent.com/hugoforte/rig/main/install.ps1 | iex
  .\install.ps1 D:\rig                        # somewhere other than C:\rig
  $env:RIG_INSTALL_SOURCE = 'D:\a\clone'      # clone from somewhere other than GitHub

An existing checkout is left exactly as it is - no fetch, no reset, no `rig update` - so
running this again is safe. Setting rig up is a separate, deliberate step (`rig prompt
setup`, or a `rig init` line of your own) and never happens here.

Windows PowerShell 5.1 and pwsh, on any platform pwsh runs on.
#>
param([string]$Path)

$ErrorActionPreference = 'Stop'

# $IsWindows is a pwsh variable: absent, and so falsy, on Windows PowerShell 5.1 - which only
# ever runs on Windows anyway.
$windows = $PSVersionTable.PSVersion.Major -lt 6 -or $IsWindows
if (-not $Path) { $Path = if ($windows) { 'C:\rig' } else { Join-Path $HOME 'rig' } }
$source = if ($env:RIG_INSTALL_SOURCE) { $env:RIG_INSTALL_SOURCE } else { 'https://github.com/hugoforte/rig.git' }

foreach ($tool in 'git', 'npm') {
  if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
    throw "rig install: $tool is not on PATH - install it and run this again"
  }
}

if (Test-Path -LiteralPath (Join-Path $Path '.git')) {
  Write-Host "a checkout is already at $Path - leaving it exactly as it is"
} elseif ((Test-Path -LiteralPath $Path) -and (Get-ChildItem -LiteralPath $Path -Force | Select-Object -First 1)) {
  throw "rig install: $Path exists, is not a git checkout, and is not empty - pass a path of your own"
} else {
  Write-Host "cloning $source into $Path"
  git clone $source $Path
  if ($LASTEXITCODE -ne 0) { throw "rig install: git clone $source failed" }
}

Write-Host "installing it globally: npm install -g $Path"
npm install -g $Path
if ($LASTEXITCODE -ne 0) { throw "rig install: npm install -g $Path failed" }

# The install is a link to the checkout, not a copy, which is what lets `rig update` move the
# command by fast-forwarding what was just cloned.
$rig = (Get-Command rig -ErrorAction SilentlyContinue).Source
if (-not $rig) {
  $prefix = npm prefix -g
  $rig = 'rig.cmd', 'bin/rig' | ForEach-Object { Join-Path $prefix $_ } |
    Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
  if (-not $rig) { throw "rig install: npm installed rig but no rig command turned up under $prefix" }
  Write-Host ''
  Write-Host "$(Split-Path $rig) is not on your PATH - add it, and rig works from anywhere"
}

Write-Host ''
& $rig help
