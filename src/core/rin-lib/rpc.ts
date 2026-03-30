export type BuiltinSlashCommand = {
  name: string
  description: string
}

export const BUILTIN_SLASH_COMMANDS: BuiltinSlashCommand[] = [
  { name: 'settings', description: 'Open settings menu' },
  { name: 'model', description: 'Select model (opens selector UI)' },
  { name: 'scoped-models', description: 'Enable/disable models for Ctrl+P cycling' },
  { name: 'export', description: 'Export session (HTML default, or specify path: .html/.jsonl)' },
  { name: 'import', description: 'Import and resume a session from a JSONL file' },
  { name: 'share', description: 'Share session as a secret GitHub gist' },
  { name: 'copy', description: 'Copy last agent message to clipboard' },
  { name: 'name', description: 'Set session display name' },
  { name: 'session', description: 'Show session info and stats' },
  { name: 'changelog', description: 'Show changelog entries' },
  { name: 'hotkeys', description: 'Show all keyboard shortcuts' },
  { name: 'fork', description: 'Create a new fork from a previous message' },
  { name: 'tree', description: 'Navigate session tree (switch branches)' },
  { name: 'login', description: 'Login with OAuth provider' },
  { name: 'logout', description: 'Logout from OAuth provider' },
  { name: 'new', description: 'Start a new session' },
  { name: 'compact', description: 'Manually compact the session context' },
  { name: 'resume', description: 'Resume a different session' },
  { name: 'reload', description: 'Reload keybindings, extensions, skills, prompts, and themes' },
  { name: 'quit', description: 'Quit pi' },
]

const SESSION_SCOPED_COMMANDS = new Set([
  'prompt',
  'interrupt_prompt',
  'steer',
  'follow_up',
  'abort',
  'get_state',
  'cycle_model',
  'get_available_models',
  'get_oauth_state',
  'set_thinking_level',
  'cycle_thinking_level',
  'set_steering_mode',
  'set_follow_up_mode',
  'compact',
  'set_auto_compaction',
  'set_auto_retry',
  'abort_retry',
  'bash',
  'abort_bash',
  'get_session_stats',
  'get_session_entries',
  'get_session_tree',
  'set_entry_label',
  'navigate_tree',
  'export_html',
  'export_jsonl',
  'import_jsonl',
  'get_fork_messages',
  'get_last_assistant_text',
  'get_messages',
  'run_command',
  'fork',
  'set_model',
  'set_session_name',
  'oauth_login_start',
  'oauth_login_respond',
  'oauth_login_cancel',
  'oauth_logout',
  'reload',
])

export function isSessionScopedCommand(type: string) {
  return SESSION_SCOPED_COMMANDS.has(type)
}

export function response(id: string | undefined, command: string, success: boolean, payload?: unknown) {
  return success
    ? payload === undefined
      ? { id, type: 'response', command, success: true }
      : { id, type: 'response', command, success: true, data: payload }
    : { id, type: 'response', command, success: false, error: String((payload as any)?.message || payload || 'rin_request_failed') }
}

export function ok(id: string | undefined, command: string, data?: unknown) {
  return response(id, command, true, data)
}

export function fail(id: string | undefined, command: string, error: unknown) {
  return response(id, command, false, error)
}

export function emptySessionState() {
  return {
    model: null,
    thinkingLevel: 'medium',
    isStreaming: false,
    isCompacting: false,
    steeringMode: 'one-at-a-time',
    followUpMode: 'one-at-a-time',
    sessionFile: undefined,
    sessionId: '',
    sessionName: undefined,
    autoCompactionEnabled: true,
    messageCount: 0,
    pendingMessageCount: 0,
  }
}
