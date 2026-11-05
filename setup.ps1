<#
  Startclip setup for Windows: optionally add Startclip to the Start Menu and the desktop, and
  print (and copy) the page address so you can bookmark it. Every step asks first; the default
  is No. No admin rights, no network; only your own Start Menu and Desktop folders are touched.

    setup.cmd              ask, then do what you said yes to
    setup.cmd -DryRun      show what would be written; write and copy nothing
    setup.cmd -Uninstall   remove only the shortcuts this script made

  Linux: run setup.sh instead.
#>
[CmdletBinding()]
param([switch]$DryRun, [switch]$Uninstall)
$ErrorActionPreference = 'Stop'

$Page = Join-Path $PSScriptRoot 'index.html'
$Icon = Join-Path $PSScriptRoot 'assets\startclip.ico'
$Mark = 'Startclip (made by setup.ps1)'
$OldMark = 'Launchpad (made by setup.ps1)'  # shortcuts from before the rename
$Programs = Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'Microsoft\Windows\Start Menu\Programs'
$MenuLink = Join-Path $Programs 'Startclip.lnk'
$OldMenuLink = Join-Path $Programs 'Launchpad.lnk'
$Desktop = [Environment]::GetFolderPath('Desktop')
$DeskLink = Join-Path $Desktop 'Startclip.lnk'
$OldDeskLink = Join-Path $Desktop 'Launchpad.lnk'

if (-not (Test-Path -LiteralPath $Page)) {
  Write-Host "index.html not found next to this script ($PSScriptRoot)."
  exit 1
}
$Shell = New-Object -ComObject WScript.Shell

# Keep conditions simple (Windows PowerShell 5.1 skips both branches of an if whose condition throws).
function Test-Ours([string]$Link) {
  $found = Test-Path -LiteralPath $Link
  if (-not $found) { return $false }
  $description = ''
  try { $description = $Shell.CreateShortcut($Link).Description } catch { return $false }
  return (($description -eq $Mark) -or ($description -eq $OldMark))
}

function Read-Yes([string]$Question) {
  $answer = Read-Host "$Question [y/N]"
  return ($answer -match '^(y|yes)$')
}

function Set-Shortcut([string]$Link, [string]$OldLink) {
  $exists = Test-Path -LiteralPath $Link
  $ours = Test-Ours $Link
  if ($exists -and -not $ours) {
    Write-Host "  skipped ${Link}: a shortcut there was not made by setup.ps1, so it is left alone."
    return
  }
  if ($DryRun) { Write-Host "  would write $Link"; return }
  try {
    $folder = Split-Path -Parent $Link
    $null = New-Item -ItemType Directory -Force -Path $folder
    $shortcut = $Shell.CreateShortcut($Link)
    $shortcut.TargetPath = $Page
    $shortcut.WorkingDirectory = $PSScriptRoot
    $shortcut.Description = $Mark
    $iconFound = Test-Path -LiteralPath $Icon
    if ($iconFound) { $shortcut.IconLocation = "$Icon,0" }
    $shortcut.Save()
    Write-Host "  wrote $Link"
    $oldOurs = Test-Ours $OldLink
    if ($oldOurs) { Remove-Item -LiteralPath $OldLink; Write-Host "  removed $OldLink" }
  } catch {
    Write-Host "  could not write ${Link}: $($_.Exception.Message)"
  }
}

if ($Uninstall) {
  foreach ($link in @($MenuLink, $DeskLink, $OldMenuLink, $OldDeskLink)) {
    $ours = Test-Ours $link
    $exists = Test-Path -LiteralPath $link
    if ($ours) {
      Remove-Item -LiteralPath $link
      Write-Host "  removed $link"
    } elseif ($exists) {
      Write-Host "  kept ${link}: not made by setup.ps1"
    }
  }
  Write-Host 'Done. Bookmarks are yours to remove in the browser.'
  exit 0
}

$Url = ([System.Uri]$Page).AbsoluteUri
Write-Host "Startclip: $Page"
Write-Host ''
if ($DryRun) { Write-Host 'Dry run: nothing will be written or copied.'; Write-Host '' }

$wantMenu = Read-Yes 'Add Startclip to the Start Menu?'
if ($wantMenu) { Set-Shortcut $MenuLink $OldMenuLink }
$wantDesk = Read-Yes 'Also put a Startclip shortcut on the desktop?'
if ($wantDesk) { Set-Shortcut $DeskLink $OldDeskLink }

Write-Host ''
Write-Host "Bookmark: open $Url and press Ctrl+D."
if ($DryRun) {
  Write-Host '(would copy the address to the clipboard)'
} else {
  try {
    Set-Clipboard -Value $Url
    Write-Host 'The address is on the clipboard.'
  } catch {
    Write-Host 'Could not reach the clipboard; copy the address above by hand.'
  }
}
