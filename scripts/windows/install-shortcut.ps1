# Puts "Start JARVIS" and "Stop JARVIS" icons on your desktop.
# Run once from the Jarvis folder:
#   powershell -ExecutionPolicy Bypass -File scripts\windows\install-shortcut.ps1
$here    = Split-Path -Parent $MyInvocation.MyCommand.Path
$desktop = [Environment]::GetFolderPath('Desktop')
$shell   = New-Object -ComObject WScript.Shell

function New-Link($name, $target, $icon, $style) {
  $link = $shell.CreateShortcut((Join-Path $desktop "$name.lnk"))
  $link.TargetPath       = $target
  $link.WorkingDirectory = $here
  $link.IconLocation     = $icon
  $link.WindowStyle      = $style   # 1 normal, 7 minimised
  $link.Save()
}

New-Link 'Start JARVIS' (Join-Path $here 'Start JARVIS.bat') (Join-Path $here 'jarvis.ico') 1
New-Link 'Stop JARVIS'  (Join-Path $here 'Stop JARVIS.bat')  "$env:SystemRoot\System32\shell32.dll,27" 7
Write-Host "Done. 'Start JARVIS' and 'Stop JARVIS' are on your desktop: $desktop"
