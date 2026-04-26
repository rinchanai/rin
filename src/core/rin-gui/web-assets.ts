export type RinGuiSurface = "auto" | "native" | "web";

export type RinGuiOptions = {
  host: string;
  port: number;
  open: boolean;
  app: boolean;
  surface: RinGuiSurface;
};

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 0;

export function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function parseRinGuiArgs(argv: string[]): RinGuiOptions {
  const options: RinGuiOptions = {
    host: DEFAULT_HOST,
    port: DEFAULT_PORT,
    open: true,
    app: false,
    surface: "auto",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = String(argv[index] || "").trim();
    if (!arg || arg === "gui") continue;
    if (arg === "--") break;

    if (arg === "--host") {
      options.host = String(argv[++index] || "").trim() || DEFAULT_HOST;
      continue;
    }
    if (arg.startsWith("--host=")) {
      options.host = arg.slice("--host=".length).trim() || DEFAULT_HOST;
      continue;
    }
    if (arg === "--port") {
      options.port = parseGuiPort(argv[++index]);
      continue;
    }
    if (arg.startsWith("--port=")) {
      options.port = parseGuiPort(arg.slice("--port=".length));
      continue;
    }
    if (arg === "--no-open") {
      options.open = false;
      continue;
    }
    if (arg === "--open") {
      options.open = true;
      continue;
    }
    if (arg === "--app") {
      options.app = true;
      continue;
    }
    if (arg === "--native") {
      options.surface = "native";
      continue;
    }
    if (arg === "--web") {
      options.surface = "web";
      continue;
    }
  }

  return options;
}

function parseGuiPort(value: unknown) {
  const port = Number(String(value ?? "").trim());
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`rin_gui_invalid_port:${String(value ?? "")}`);
  }
  return port;
}

export function buildGuiHtml(options: { title?: string } = {}) {
  const title = escapeHtml(options.title || "Rin GUI");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
  <style>
    :root { color-scheme: light dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; background: Canvas; color: CanvasText; }
    main { display: grid; grid-template-rows: auto 1fr auto; height: 100vh; }
    header { padding: 12px 16px; border-bottom: 1px solid color-mix(in srgb, CanvasText 18%, transparent); }
    h1 { margin: 0; font-size: 18px; }
    #status { font-size: 12px; opacity: 0.72; margin-top: 4px; }
    #messages { overflow: auto; padding: 16px; display: flex; flex-direction: column; gap: 10px; }
    .message { border: 1px solid color-mix(in srgb, CanvasText 15%, transparent); border-radius: 10px; padding: 10px 12px; white-space: pre-wrap; }
    .message.user { align-self: flex-end; background: color-mix(in srgb, Highlight 14%, Canvas); }
    .message.assistant { align-self: flex-start; background: color-mix(in srgb, CanvasText 5%, Canvas); }
    .message.system { align-self: center; font-size: 12px; opacity: 0.72; }
    form { display: grid; grid-template-columns: 1fr auto auto; gap: 8px; padding: 12px 16px; border-top: 1px solid color-mix(in srgb, CanvasText 18%, transparent); }
    textarea { resize: vertical; min-height: 44px; max-height: 30vh; border-radius: 8px; padding: 10px; font: inherit; }
    button { border-radius: 8px; padding: 0 14px; font: inherit; }
  </style>
</head>
<body>
  <main>
    <header>
      <h1>${title}</h1>
      <div id="status">Connecting…</div>
    </header>
    <section id="messages" aria-live="polite"></section>
    <form id="prompt-form">
      <textarea id="prompt" placeholder="Ask Rin…" autofocus></textarea>
      <button type="submit">Send</button>
      <button id="abort" type="button">Abort</button>
    </form>
  </main>
  <script>
    const statusEl = document.getElementById('status');
    const messagesEl = document.getElementById('messages');
    const form = document.getElementById('prompt-form');
    const promptEl = document.getElementById('prompt');
    const abortEl = document.getElementById('abort');
    const socket = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/rpc');
    const activeMessages = new Map();

    function appendMessage(role, text, id) {
      let node = id ? activeMessages.get(id) : null;
      if (!node) {
        node = document.createElement('div');
        node.className = 'message ' + (role || 'system');
        if (id) activeMessages.set(id, node);
        messagesEl.appendChild(node);
      }
      node.textContent += text || '';
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function appendSystem(text) {
      const node = document.createElement('div');
      node.className = 'message system';
      node.textContent = text;
      messagesEl.appendChild(node);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    socket.addEventListener('open', () => { statusEl.textContent = 'Connected'; });
    socket.addEventListener('close', () => { statusEl.textContent = 'Disconnected'; });
    socket.addEventListener('error', () => { statusEl.textContent = 'Connection error'; });
    socket.addEventListener('message', (message) => {
      const data = JSON.parse(message.data);
      if (data.type === 'status') {
        statusEl.textContent = data.text || data.level || 'Status';
        return;
      }
      const event = data.event || data;
      if (event.type === 'message_delta') {
        appendMessage(event.role, event.delta, event.messageId);
        return;
      }
      if (event.type === 'status') {
        appendSystem(event.text || 'status');
        return;
      }
      if (event.type === 'ui') {
        appendSystem(JSON.stringify(event.payload || event));
      }
    });

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const text = promptEl.value.trim();
      if (!text || socket.readyState !== WebSocket.OPEN) return;
      appendMessage('user', text);
      socket.send(JSON.stringify({ type: 'prompt', text }));
      promptEl.value = '';
    });
    abortEl.addEventListener('click', () => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'abort' }));
    });
  </script>
</body>
</html>`;
}
