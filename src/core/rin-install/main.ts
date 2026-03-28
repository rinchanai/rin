#!/usr/bin/env node
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'

import { cancel, confirm, intro, isCancel, note, outro, select, text } from '@clack/prompts'

import { createConfiguredAgentSession, resolveRuntimeProfile } from '../rin-lib/runtime.js'

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

function targetHomeForUser(targetUser: string) {
  const matched = listSystemUsers().find((entry) => entry.name === targetUser)
  return matched?.home || path.join('/home', targetUser)
}

function summarizeDirState(dir: string) {
  try {
    const entries = fs.readdirSync(dir)
    return {
      exists: true,
      entryCount: entries.length,
      sample: entries.slice(0, 8),
    }
  } catch {
    return {
      exists: false,
      entryCount: 0,
      sample: [] as string[],
    }
  }
}

function computeAvailableThinkingLevels(model: { provider: string; id: string; reasoning: boolean }) {
  if (!model.reasoning) return ['off']
  const id = String(model.id || '').toLowerCase()
  const provider = String(model.provider || '').toLowerCase()
  return provider === 'openai' && id.includes('codex-max')
    ? ['off', 'minimal', 'low', 'medium', 'high', 'xhigh']
    : ['off', 'minimal', 'low', 'medium', 'high']
}

async function loadModelChoices() {
  const { getProviders, getModels } = await import('@mariozechner/pi-ai')

  const merged = new Map<string, { provider: string; id: string; reasoning: boolean; available: boolean }>()

  for (const provider of getProviders()) {
    for (const model of getModels(provider as any)) {
      merged.set(`${(model as any).provider || provider}/${(model as any).id || ''}`, {
        provider: String((model as any).provider || provider),
        id: String((model as any).id || ''),
        reasoning: Boolean((model as any).reasoning),
        available: false,
      })
    }
  }

  try {
    const runtimeProfile = resolveRuntimeProfile()
    const session = await createConfiguredAgentSession({
      cwd: runtimeProfile.cwd,
      agentDir: runtimeProfile.agentDir,
    })
    const registry = (session as any).modelRegistry
    const all = Array.isArray(registry?.getAll?.()) ? registry.getAll() : []
    const availableKeys = new Set(
      (Array.isArray(registry?.getAvailable?.()) ? registry.getAvailable() : []).map((model: any) => `${model.provider}/${model.id}`),
    )
    for (const model of all) {
      merged.set(`${model.provider}/${model.id}`, {
        provider: String(model.provider || ''),
        id: String(model.id || ''),
        reasoning: Boolean(model.reasoning),
        available: availableKeys.has(`${model.provider}/${model.id}`),
      })
    }
  } catch {}

  const choices = [...merged.values()].filter((model) => model.provider && model.id)
  choices.sort((a, b) => a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id))
  return choices
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

  const defaultDir = path.join(targetHomeForUser(targetUser), '.rin')
  const installDir = String(ensureNotCancelled(await text({
    message: 'Choose the Rin data directory for the daemon user.',
    placeholder: defaultDir,
    defaultValue: defaultDir,
    validate(value) {
      const next = String(value || '').trim()
      if (!next) return 'Directory is required.'
      if (!path.isAbsolute(next)) return 'Use an absolute path.'
    },
  }))).trim()

  const state = summarizeDirState(installDir)
  if (state.exists) {
    note([
      `Directory exists: ${installDir}`,
      `Existing entries: ${state.entryCount}`,
      state.sample.length ? `Sample: ${state.sample.join(', ')}` : '',
      '',
      'Installer policy:',
      '- keep unknown files untouched',
      '- keep existing config unless a required file must be updated',
      '- only remove old files when they are known legacy Rin artifacts',
    ].filter(Boolean).join('\n'), 'Existing directory')
  } else {
    note([
      `Directory will be created: ${installDir}`,
      '',
      'Installer policy:',
      '- create only the files Rin needs',
      '- future updates should preserve unknown files',
    ].join('\n'), 'Install directory')
  }

  const models = await loadModelChoices()
  const providerNames = [...new Set(models.map((model) => model.provider).filter(Boolean))]
  if (!providerNames.length) {
    throw new Error('rin_installer_no_models_available')
  }

  const provider = ensureNotCancelled(await select({
    message: 'Choose a provider.',
    options: providerNames.map((name) => {
      const scoped = models.filter((model) => model.provider === name)
      const availableCount = scoped.filter((model) => model.available).length
      return {
        value: name,
        label: name,
        hint: availableCount ? `${availableCount}/${scoped.length} ready` : `${scoped.length} models`,
      }
    }),
  }))

  const providerModels = models.filter((model) => model.provider === provider)
  if (!providerModels.length) {
    throw new Error(`rin_installer_no_models_for_provider:${provider}`)
  }
  const modelId = ensureNotCancelled(await select({
    message: 'Choose a model.',
    options: providerModels.map((model) => ({
      value: model.id,
      label: model.id,
      hint: [model.available ? 'ready' : 'needs auth/config', model.reasoning ? 'reasoning' : 'no reasoning'].join(' · '),
    })),
  }))

  const model = providerModels.find((entry) => entry.id === modelId)!
  const thinkingLevel = ensureNotCancelled(await select({
    message: 'Choose the default thinking level.',
    options: computeAvailableThinkingLevels(model).map((level) => ({
      value: level,
      label: level,
    })),
  }))

  const enableKoishi = ensureNotCancelled(await confirm({
    message: 'Configure a Koishi adapter now?',
    initialValue: false,
  }))

  let koishiDescription = 'disabled for now'
  let koishiDetail = ''
  if (enableKoishi) {
    const adapter = ensureNotCancelled(await select({
      message: 'Choose a Koishi adapter.',
      options: [
        { value: 'telegram', label: 'Telegram', hint: 'bot token' },
        { value: 'onebot', label: 'OneBot', hint: 'endpoint URL' },
      ],
    })) as 'telegram' | 'onebot'

    koishiDescription = adapter
    if (adapter === 'telegram') {
      ensureNotCancelled(await text({
        message: 'Enter the Telegram bot token.',
        placeholder: '123456:ABCDEF...',
        validate(value) {
          if (!String(value || '').trim()) return 'Token is required.'
        },
      }))
      koishiDetail = 'Koishi token: [saved later during real install]'
    } else {
      const endpoint = String(ensureNotCancelled(await text({
        message: 'Enter the OneBot endpoint URL.',
        placeholder: 'http://127.0.0.1:5700',
        validate(value) {
          const next = String(value || '').trim()
          if (!next) return 'Endpoint is required.'
          try {
            new URL(next)
          } catch {
            return 'Use a valid URL.'
          }
        },
      }))).trim()
      koishiDetail = `Koishi endpoint: ${endpoint}`
    }
  }

  note([
    `Current user: ${currentUser}`,
    `Target daemon user: ${targetUser}`,
    `Install dir: ${installDir}`,
    `Provider: ${provider}`,
    `Model: ${modelId}`,
    `Thinking level: ${thinkingLevel}`,
    `Model auth status: ${model.available ? 'ready' : 'needs auth/config later'}`,
    `Koishi: ${koishiDescription}`,
    koishiDetail,
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

