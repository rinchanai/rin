import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import type { RinDaemonFrontendClient } from "../rin-tui/rpc-client.js";

export type NativeDesktopPlatform = "win32" | "darwin" | "linux";

type NativeDesktopScript = {
  platform: NativeDesktopPlatform;
  extension: string;
  command: string;
  args: (scriptPath: string) => string[];
  source: string;
};

function psSingleQuote(value: string) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function jsString(value: string) {
  return JSON.stringify(value);
}

function pyString(value: string) {
  return JSON.stringify(value);
}

export function nativeDesktopPlatformFor(
  platform: NodeJS.Platform = process.platform,
): NativeDesktopPlatform {
  if (platform === "win32" || platform === "darwin" || platform === "linux") {
    return platform;
  }
  throw new Error(`rin_gui_native_platform_unsupported:${platform}`);
}

function buildWindowsScript(title: string) {
  return `$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName WindowsBase

function Send-RinGuiCommand([hashtable] $Command) {
  $json = $Command | ConvertTo-Json -Compress
  [Console]::Out.WriteLine($json)
  [Console]::Out.Flush()
}

$window = New-Object System.Windows.Window
$window.Title = ${psSingleQuote(title)}
$window.Width = 980
$window.Height = 720
$window.MinWidth = 720
$window.MinHeight = 480
$window.WindowStartupLocation = 'CenterScreen'

$root = New-Object System.Windows.Controls.Grid
$row0 = New-Object System.Windows.Controls.RowDefinition
$row0.Height = [System.Windows.GridLength]::Auto
$row1 = New-Object System.Windows.Controls.RowDefinition
$row1.Height = New-Object System.Windows.GridLength(1, [System.Windows.GridUnitType]::Star)
$row2 = New-Object System.Windows.Controls.RowDefinition
$row2.Height = [System.Windows.GridLength]::Auto
$root.RowDefinitions.Add($row0)
$root.RowDefinitions.Add($row1)
$root.RowDefinitions.Add($row2)

$status = New-Object System.Windows.Controls.TextBlock
$status.Text = 'Starting native Rin GUI...'
$status.Margin = '12,10,12,6'
$status.FontSize = 13
$status.Opacity = 0.78
[System.Windows.Controls.Grid]::SetRow($status, 0)
$root.Children.Add($status) | Out-Null

$messages = New-Object System.Windows.Controls.TextBox
$messages.Margin = '12,6,12,8'
$messages.IsReadOnly = $true
$messages.AcceptsReturn = $true
$messages.VerticalScrollBarVisibility = 'Auto'
$messages.TextWrapping = 'Wrap'
$messages.FontFamily = 'Consolas'
$messages.FontSize = 13
[System.Windows.Controls.Grid]::SetRow($messages, 1)
$root.Children.Add($messages) | Out-Null

$inputGrid = New-Object System.Windows.Controls.Grid
$inputGrid.Margin = '12,0,12,12'
$col0 = New-Object System.Windows.Controls.ColumnDefinition
$col0.Width = New-Object System.Windows.GridLength(1, [System.Windows.GridUnitType]::Star)
$col1 = New-Object System.Windows.Controls.ColumnDefinition
$col1.Width = [System.Windows.GridLength]::Auto
$col2 = New-Object System.Windows.Controls.ColumnDefinition
$col2.Width = [System.Windows.GridLength]::Auto
$inputGrid.ColumnDefinitions.Add($col0)
$inputGrid.ColumnDefinitions.Add($col1)
$inputGrid.ColumnDefinitions.Add($col2)

$prompt = New-Object System.Windows.Controls.TextBox
$prompt.AcceptsReturn = $true
$prompt.MinHeight = 52
$prompt.MaxHeight = 140
$prompt.TextWrapping = 'Wrap'
$prompt.VerticalScrollBarVisibility = 'Auto'
$prompt.Margin = '0,0,8,0'
[System.Windows.Controls.Grid]::SetColumn($prompt, 0)
$inputGrid.Children.Add($prompt) | Out-Null

$send = New-Object System.Windows.Controls.Button
$send.Content = 'Send'
$send.Width = 86
$send.Margin = '0,0,8,0'
[System.Windows.Controls.Grid]::SetColumn($send, 1)
$inputGrid.Children.Add($send) | Out-Null

$abort = New-Object System.Windows.Controls.Button
$abort.Content = 'Abort'
$abort.Width = 86
[System.Windows.Controls.Grid]::SetColumn($abort, 2)
$inputGrid.Children.Add($abort) | Out-Null

[System.Windows.Controls.Grid]::SetRow($inputGrid, 2)
$root.Children.Add($inputGrid) | Out-Null
$window.Content = $root

function Append-RinGuiText([string] $Role, [string] $Text) {
  if ([string]::IsNullOrWhiteSpace($Text)) { return }
  if ($messages.Text.Length -gt 0) { $messages.AppendText("\`r\`n") }
  if (-not [string]::IsNullOrWhiteSpace($Role)) { $messages.AppendText("[$Role] ") }
  $messages.AppendText($Text)
  $messages.ScrollToEnd()
}

$send.Add_Click({
  $text = $prompt.Text.Trim()
  if ($text.Length -eq 0) { return }
  Append-RinGuiText 'user' $text
  $prompt.Clear()
  Send-RinGuiCommand @{ type = 'prompt'; text = $text }
})

$abort.Add_Click({ Send-RinGuiCommand @{ type = 'abort' } })

$reader = [System.Threading.Thread]::new([System.Threading.ThreadStart] {
  while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    try { $payload = $line | ConvertFrom-Json } catch { continue }
    $window.Dispatcher.Invoke([Action] {
      if ($payload.type -eq 'status') {
        $status.Text = [string] $payload.text
        return
      }
      if ($payload.type -eq 'message') {
        Append-RinGuiText ([string] $payload.role) ([string] $payload.text)
        return
      }
      Append-RinGuiText 'event' ($payload | ConvertTo-Json -Compress)
    }) | Out-Null
  }
})
$reader.IsBackground = $true
$reader.Start()

$window.Add_Closed({ Send-RinGuiCommand @{ type = 'close' } })
$status.Text = 'Connected to local Rin daemon'
$prompt.Focus() | Out-Null
$window.ShowDialog() | Out-Null
`;
}

function buildMacosScript(title: string) {
  return `ObjC.import('Cocoa')
ObjC.import('Foundation')

function writeLine(value) {
  const text = JSON.stringify(value) + '\\n'
  const data = $.NSString.alloc.initWithUTF8String(text).dataUsingEncoding($.NSUTF8StringEncoding)
  $.NSFileHandle.fileHandleWithStandardOutput.writeData(data)
}

const app = $.NSApplication.sharedApplication
app.setActivationPolicy($.NSApplicationActivationPolicyRegular)

const rect = $.NSMakeRect(0, 0, 980, 720)
const style = $.NSWindowStyleMaskTitled | $.NSWindowStyleMaskClosable | $.NSWindowStyleMaskResizable | $.NSWindowStyleMaskMiniaturizable
const window = $.NSWindow.alloc.initWithContentRectStyleMaskBackingDefer(rect, style, $.NSBackingStoreBuffered, false)
window.title = ${jsString(title)}
window.center
window.makeKeyAndOrderFront(null)
app.activateIgnoringOtherApps(true)

const root = window.contentView
const status = $.NSTextField.alloc.initWithFrame($.NSMakeRect(16, 680, 948, 22))
status.editable = false
status.bezeled = false
status.drawsBackground = false
status.stringValue = 'Connected to local Rin daemon'
root.addSubview(status)

const scroll = $.NSScrollView.alloc.initWithFrame($.NSMakeRect(16, 84, 948, 584))
scroll.hasVerticalScroller = true
const messages = $.NSTextView.alloc.initWithFrame($.NSMakeRect(0, 0, 948, 584))
messages.editable = false
scroll.documentView = messages
root.addSubview(scroll)

const prompt = $.NSTextField.alloc.initWithFrame($.NSMakeRect(16, 24, 748, 36))
prompt.placeholderString = 'Ask Rin…'
root.addSubview(prompt)

const send = $.NSButton.alloc.initWithFrame($.NSMakeRect(776, 24, 86, 36))
send.title = 'Send'
send.bezelStyle = $.NSBezelStyleRounded
root.addSubview(send)

const abort = $.NSButton.alloc.initWithFrame($.NSMakeRect(878, 24, 86, 36))
abort.title = 'Abort'
abort.bezelStyle = $.NSBezelStyleRounded
root.addSubview(abort)

function append(role, text) {
  if (!text) return
  const prefix = role ? '[' + role + '] ' : ''
  messages.textStorage.appendAttributedString($.NSAttributedString.alloc.initWithString(prefix + text + '\\n'))
}

const target = $.NSObject.alloc.init
send.target = target
send.action = 'sendPrompt:'
target.sendPrompt = function() {
  const text = ObjC.unwrap(prompt.stringValue).trim()
  if (!text) return
  append('user', text)
  prompt.stringValue = ''
  writeLine({ type: 'prompt', text })
}
abort.target = target
abort.action = 'abortPrompt:'
target.abortPrompt = function() { writeLine({ type: 'abort' }) }

writeLine({ type: 'ready' })
app.run
`;
}

function buildLinuxScript(title: string) {
  return `import json
import queue
import sys
import threading
import tkinter as tk
from tkinter import ttk

out_lock = threading.Lock()
events = queue.Queue()

def write_line(value):
    with out_lock:
        sys.stdout.write(json.dumps(value, separators=(",", ":")) + "\\n")
        sys.stdout.flush()

def reader():
    for line in sys.stdin:
        try:
            events.put(json.loads(line))
        except Exception:
            pass

root = tk.Tk()
root.title(${pyString(title)})
root.geometry("980x720")
root.minsize(720, 480)

status = ttk.Label(root, text="Connected to local Rin daemon")
status.pack(fill="x", padx=12, pady=(10, 6))

messages = tk.Text(root, wrap="word", state="disabled")
messages.pack(fill="both", expand=True, padx=12, pady=(0, 8))

bottom = ttk.Frame(root)
bottom.pack(fill="x", padx=12, pady=(0, 12))

prompt = tk.Text(bottom, height=3, wrap="word")
prompt.pack(side="left", fill="x", expand=True, padx=(0, 8))

def append(role, text):
    if not text:
        return
    messages.configure(state="normal")
    prefix = f"[{role}] " if role else ""
    messages.insert("end", prefix + text + "\\n")
    messages.see("end")
    messages.configure(state="disabled")

def send_prompt():
    text = prompt.get("1.0", "end").strip()
    if not text:
        return
    append("user", text)
    prompt.delete("1.0", "end")
    write_line({"type": "prompt", "text": text})

def abort_prompt():
    write_line({"type": "abort"})

ttk.Button(bottom, text="Send", command=send_prompt).pack(side="left", padx=(0, 8))
ttk.Button(bottom, text="Abort", command=abort_prompt).pack(side="left")

def poll_events():
    while True:
        try:
            payload = events.get_nowait()
        except queue.Empty:
            break
        kind = payload.get("type")
        if kind == "status":
            status.configure(text=str(payload.get("text", "")))
        elif kind == "message":
            append(str(payload.get("role", "")), str(payload.get("text", "")))
        else:
            append("event", json.dumps(payload, separators=(",", ":")))
    root.after(50, poll_events)

def on_close():
    write_line({"type": "close"})
    root.destroy()

threading.Thread(target=reader, daemon=True).start()
root.protocol("WM_DELETE_WINDOW", on_close)
root.after(50, poll_events)
prompt.focus_set()
write_line({"type": "ready"})
root.mainloop()
`;
}

export function buildNativeDesktopGuiScript(
  options: {
    title?: string;
    platform?: NodeJS.Platform;
  } = {},
): NativeDesktopScript {
  const title = options.title || "Rin";
  const platform = nativeDesktopPlatformFor(options.platform);
  if (platform === "win32") {
    return {
      platform,
      extension: "ps1",
      command: "powershell.exe",
      args: (scriptPath) => [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        scriptPath,
      ],
      source: buildWindowsScript(title),
    };
  }
  if (platform === "darwin") {
    return {
      platform,
      extension: "js",
      command: "osascript",
      args: (scriptPath) => ["-l", "JavaScript", scriptPath],
      source: buildMacosScript(title),
    };
  }
  return {
    platform,
    extension: "py",
    command: "python3",
    args: (scriptPath) => [scriptPath],
    source: buildLinuxScript(title),
  };
}

export function createNativeDesktopGuiScriptFile(script: NativeDesktopScript) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rin-native-gui-"));
  const scriptPath = path.join(dir, `rin-native-gui.${script.extension}`);
  fs.writeFileSync(scriptPath, script.source, "utf8");
  return { dir, scriptPath };
}

function frontendEventText(event: any) {
  if (!event || typeof event !== "object") return "";
  if (event.type === "status") return String(event.text || "");
  const payload = event.payload || event;
  if (typeof payload.delta === "string") return payload.delta;
  if (typeof payload.text === "string") return payload.text;
  if (typeof payload.message === "string") return payload.message;
  return JSON.stringify(payload);
}

function sendNativeEvent(stdin: NodeJS.WritableStream, payload: unknown) {
  stdin.write(`${JSON.stringify(payload)}\n`);
}

export async function runNativeDesktopGui(options: {
  client: RinDaemonFrontendClient;
  title?: string;
  platform?: NodeJS.Platform;
}) {
  const script = buildNativeDesktopGuiScript({
    title: options.title,
    platform: options.platform,
  });
  const { dir, scriptPath } = createNativeDesktopGuiScriptFile(script);
  const child = spawn(script.command, script.args(scriptPath), {
    stdio: ["pipe", "pipe", "inherit"],
    windowsHide: false,
  });

  const client = options.client;
  const unsubscribe = client.subscribe((event) => {
    sendNativeEvent(child.stdin, {
      type: event.type === "status" ? "status" : "message",
      role: event.type === "status" ? "system" : event.type,
      text: frontendEventText(event),
    });
  });

  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += String(chunk);
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
      if (!line) continue;
      void (async () => {
        let command: any;
        try {
          command = JSON.parse(line);
        } catch {
          return;
        }
        if (command?.type === "prompt") {
          await client.submit(String(command.text || ""));
        } else if (command?.type === "abort") {
          await client.abort();
        } else if (command?.type === "close") {
          child.kill();
        }
      })().catch((error) => {
        sendNativeEvent(child.stdin, {
          type: "status",
          text: String(
            error?.message || error || "rin_native_gui_command_failed",
          ),
        });
      });
    }
  });

  sendNativeEvent(child.stdin, {
    type: "status",
    text: "Connected to local Rin daemon",
  });

  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", () => resolve());
  }).finally(() => {
    unsubscribe();
    try {
      child.stdin.end();
    } catch {}
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  });
}
