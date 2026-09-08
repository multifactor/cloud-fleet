# Console-input injection for a session running in a Windows Terminal tab or a PowerShell window.
#
#   powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File wt-inject.ps1 `
#       -TargetPid <pid> [-TextBase64 <base64 of UTF-16LE text>] [-Enter]
#
# Prints ONE integer on stdout: how many characters the target console's input buffer accepted
# (with -Enter, 1 when the Enter landed). The caller LOOPS ON THAT NUMBER. WriteConsoleInput takes
# what fits in the ~256-record buffer and reports the count; whatever was not counted was never
# typed, and an Enter sent after it would submit the fragment — which is how a ~700-character
# message once arrived as 62 characters and the session acted on them. Text and Enter are separate
# invocations for the same reason: Enter is only sent once every chunk is known to have landed.
#
# FreeConsole BEFORE AttachConsole: a process cannot attach to a console while it owns one, and the
# caller starts this helper with a hidden console of its own (never inside the launcher's window, so
# nothing here can ever type into the launcher). stdout and stderr are bound BEFORE any console call,
# so the count goes back down the caller's pipe rather than onto the session's screen.
#
# One character is two records (key down, key up) and a character counts only when both landed, so
# the number can under-report by one on a torn write — the safe direction: the caller retries a
# chunk it believes short, it never trusts a chunk that was not typed.
param(
  [Parameter(Mandatory = $true)][int]$TargetPid,
  [string]$TextBase64 = '',
  [switch]$Enter
)

$ErrorActionPreference = 'Stop'
$out = [Console]::Out
$err = [Console]::Error

Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

namespace FleetInject {
  public static class Injector {
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool FreeConsole();
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool AttachConsole(uint dwProcessId);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern IntPtr CreateFileW(string lpFileName, uint dwDesiredAccess, uint dwShareMode, IntPtr lpSecurityAttributes, uint dwCreationDisposition, uint dwFlagsAndAttributes, IntPtr hTemplateFile);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr hObject);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool WriteConsoleInputW(IntPtr hConsoleInput, INPUT_RECORD[] lpBuffer, uint nLength, out uint lpNumberOfEventsWritten);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct KEY_EVENT_RECORD {
      public int bKeyDown; public ushort wRepeatCount; public ushort wVirtualKeyCode; public ushort wVirtualScanCode;
      public char UnicodeChar; public uint dwControlKeyState;
    }
    [StructLayout(LayoutKind.Explicit)]
    struct INPUT_RECORD { [FieldOffset(0)] public ushort EventType; [FieldOffset(4)] public KEY_EVENT_RECORD KeyEvent; }

    const ushort KEY_EVENT = 0x0001;
    const ushort VK_RETURN = 0x0D;
    const uint GENERIC_READ = 0x80000000, GENERIC_WRITE = 0x40000000, FILE_SHARE_READ = 0x1, FILE_SHARE_WRITE = 0x2, OPEN_EXISTING = 3;
    static readonly IntPtr INVALID_HANDLE = new IntPtr(-1);

    static INPUT_RECORD Key(char c, ushort vk, bool down) {
      INPUT_RECORD r = new INPUT_RECORD();
      r.EventType = KEY_EVENT;
      r.KeyEvent.bKeyDown = down ? 1 : 0;
      r.KeyEvent.wRepeatCount = 1;
      r.KeyEvent.wVirtualKeyCode = vk;
      r.KeyEvent.wVirtualScanCode = 0;
      r.KeyEvent.UnicodeChar = c;
      r.KeyEvent.dwControlKeyState = 0;
      return r;
    }

    // Characters accepted by the target console's input buffer; throws with the Win32 error otherwise.
    public static int Inject(uint pid, string text, bool enter) {
      FreeConsole();
      if (!AttachConsole(pid)) throw new Win32Exception(Marshal.GetLastWin32Error(), "AttachConsole(" + pid + ")");
      // CONIN$ rather than GetStdHandle: this process's own stdin handle was bound before the attach and says nothing about the target.
      IntPtr h = CreateFileW("CONIN$", GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE, IntPtr.Zero, OPEN_EXISTING, 0, IntPtr.Zero);
      if (h == INVALID_HANDLE) throw new Win32Exception(Marshal.GetLastWin32Error(), "CONIN$");
      try {
        string s = (text ?? "") + (enter ? "\r" : "");
        if (s.Length == 0) return 0;
        INPUT_RECORD[] recs = new INPUT_RECORD[s.Length * 2];
        for (int i = 0; i < s.Length; i++) {
          char c = s[i];
          ushort vk = c == '\r' ? VK_RETURN : (ushort)0;
          recs[2 * i] = Key(c, vk, true);
          recs[2 * i + 1] = Key(c, vk, false);
        }
        uint written;
        if (!WriteConsoleInputW(h, recs, (uint)recs.Length, out written)) throw new Win32Exception(Marshal.GetLastWin32Error(), "WriteConsoleInputW");
        return (int)(written / 2);
      } finally {
        CloseHandle(h);
        FreeConsole();
      }
    }
  }
}
'@

$text = ''
if ($TextBase64 -ne '') { $text = [System.Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($TextBase64)) }

try {
  $n = [FleetInject.Injector]::Inject([uint32]$TargetPid, $text, [bool]$Enter)
  $out.WriteLine($n)
  exit 0
} catch {
  $err.WriteLine($_.Exception.Message)
  exit 2
}
