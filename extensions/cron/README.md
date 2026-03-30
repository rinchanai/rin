# cron

Daemon-backed scheduled tasks for Rin.

Provides:
- recurring interval tasks
- cron-expression tasks
- one-time scheduled tasks
- agent-prompt jobs that keep reusing the same session
- direct shell-command jobs
- task completion/pause/resume/delete management through the `manage_scheduled_tasks` tool

Notes:
- interval schedules are measured from task start time
- tasks may bind to the current session, a dedicated session, or a specific session file
- tasks created from Koishi chats automatically bind back to that chat when possible, and scheduled results are sent back through the Koishi sidecar
