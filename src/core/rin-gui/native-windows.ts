import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import type { RinDaemonFrontendClient } from "../rin-tui/rpc-client.js";

function psSingleQuote(value: string) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

export function buildWindowsNativeGuiScript(options: { title?: string } = {}) {
  const title = options.title || "Rin";
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

export function createWindowsNativeGuiScriptFile(script: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rin-native-gui-"));
  const scriptPath = path.join(dir, "rin-native-gui.ps1");
  fs.writeFileSync(scriptPath, script, "utf8");
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

export async function runWindowsNativeGui(options: {
  client: RinDaemonFrontendClient;
  title?: string;
  powershell?: string;
}) {
  const script = buildWindowsNativeGuiScript({ title: options.title });
  const { dir, scriptPath } = createWindowsNativeGuiScriptFile(script);
  const powershell = options.powershell || "powershell.exe";
  const child = spawn(
    powershell,
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
    { stdio: ["pipe", "pipe", "inherit"], windowsHide: false },
  );

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
