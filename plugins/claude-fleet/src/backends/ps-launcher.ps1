# The launcher a bare PowerShell window runs when Windows Terminal is absent:
#
#   powershell -NoExit -NoProfile -ExecutionPolicy Bypass -File ps-launcher.ps1 <title> <cwd> <command> [args...]
#
# It sets the window title (the token focus() looks for), moves into the worktree and runs the shim
# in the foreground. -NoExit keeps the window open after the shim exits so the operator can read how
# the session ended; the window closes when the fleet kills the tree, because this powershell.exe is
# its root (the shim's whole argv, marker included, is on this window's own command line).
#
# No param() block, on purpose. With one, powershell.exe binds every argument that starts with "-"
# as a PARAMETER of this script, and the shim's own argv carries such tokens: `-e` is refused as
# "ambiguous: -ErrorAction, -ErrorVariable" and `--fleet-session=3` never reaches the shim. $args is
# bound positionally and literally, which is the only way the command line survives intact.

if ($args.Count -lt 3) {
  [Console]::Error.WriteLine('usage: ps-launcher.ps1 <title> <cwd> <command> [args...]')
  exit 2
}

$title = [string]$args[0]
$cwd = [string]$args[1]
$command = [string]$args[2]
$rest = @()
if ($args.Count -gt 3) { $rest = @($args[3..($args.Count - 1)]) }

$Host.UI.RawUI.WindowTitle = $title
Set-Location -LiteralPath $cwd
& $command @rest
