#!/usr/bin/env node
import os from 'node:os'
import fs from 'node:fs'

import { cancel, intro, isCancel, note, outro, select, text } from '@clack/prompts'

function listSystemUsers() {
  const users: Array<{ name: string; uid: number; home: string; shell: string }> = []
  try {
    const raw = fs.readFileSync('/etc/passwd', 'utf8')
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim() || line.startsWith('#')) continue
      const [name = '', , uidRaw = '', , , home = '', shell = ''] = line.split(':')
      const uid = Number(uidRaw || 0)
      if (!name) continue
      if (!Number.isFinite(uid)) continue
      if (uid < 1000) continue
      if (name === 'nobody') continue
      if (/nologin|false/.test(shell)) continue
      users.push({ name, uid, home, shell })
    }
  } catch {}
  return users.sort((a, b) => a.uid - b.uid || a.name.localeCompare(b.name))
}

function ensureNotCancelled<T>(value: T | symbol): T {
  if (isCancel(value)) {
    cancel('Installer cancelled.')
    process.exit(1)
  }
  return value as T
}

export async function startInstaller() {
  const currentUser = os.userInfo().username
  const allUsers = listSystemUsers()
  const otherUsers = allUsers.filter((entry) => entry.name !== currentUser)

  intro('Rin Installer')

  const targetMode = ensureNotCancelled(await select({
    message: 'Choose the target user for the Rin daemon.',
    options: [
      { value: 'current', label: `Current user`, hint: currentUser },
      { value: 'existing', label: 'Existing other user', hint: otherUsers.length ? `${otherUsers.length} user(s)` : 'none found' },
      { value: 'new', label: 'New user', hint: 'enter a username' },
    ],
  }))

  let targetUser = currentUser
  if (targetMode === 'existing') {
    if (!otherUsers.length) {
      note('No eligible existing users were found on this system.', 'Target user')
      outro('Nothing installed.')
      return
    }
    targetUser = ensureNotCancelled(await select({
      message: 'Choose the existing user to host the Rin daemon.',
      options: otherUsers.map((entry) => ({
        value: entry.name,
        label: entry.name,
        hint: `${entry.home} · uid ${entry.uid}`,
      })),
    }))
  } else if (targetMode === 'new') {
    targetUser = ensureNotCancelled(await text({
      message: 'Enter the new username to create for the Rin daemon.',
      placeholder: 'rin',
      validate(value) {
        const next = String(value || '').trim()
        if (!next) return 'Username is required.'
        if (!/^[a-z_][a-z0-9_-]*[$]?$/i.test(next)) return 'Use a normal Unix username.'
      },
    }))
  }

  note([
    `Current user: ${currentUser}`,
    `Target daemon user: ${targetUser}`,
    '',
    'Planned command shape:',
    '- `rin` → RPC TUI for the target user',
    '- `rin --std` → std TUI for the target user',
    '- `rin --tmux <session_name>` → attach/create a hidden Rin tmux session for the target user',
    '- `rin --tmux-list` → list Rin tmux sessions for the target user',
    '',
    'This installer is still a dry run. Nothing has been installed yet.',
  ].join('\n'), 'Install plan')

  outro('Installer placeholder complete. No changes were made.')
}

