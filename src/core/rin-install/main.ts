#!/usr/bin/env node
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'

import { cancel, confirm, intro, isCancel, note, outro, select, spinner, text } from '@clack/prompts'
import { getModels, getProviders } from '@mariozechner/pi-ai'

import { createConfiguredAgentSession, resolveRuntimeProfile } from '../rin-lib/runtime.js'

const ALL_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const
const BACK = Symbol('rin_installer_back')

type Back = typeof BACK
type SystemUser = { name: string; uid: number; home: string; shell: string }
type ModelChoice = { provider: string; id: string; reasoning: boolean; available: boolean }
type InstallerAgentContext = {
  models: ModelChoice[]
  authStorage: any | null
}
type TargetUserPlan = { targetUser: string; targetMode: string }
type ModelPlan = { provider: string; modelId: string; thinkingLevel: string; modelAvailable: boolean }
type KoishiPlan =
  | { enabled: false }
  | { enabled: true; adapter: 'telegram'; token: string }
  | { enabled: true; adapter: 'onebot'; endpoint: string }

function isBack(value: unknown): value is Back {
  return value === BACK
}

async function promptSelect<T extends string>(options: Parameters<typeof select>[0]): Promise<T | Back> {
  const value = await select(options as any)
  return isCancel(value) ? BACK : value as T
}

async function promptText(options: Parameters<typeof text>[0]): Promise<string | Back> {
  const value = await text(options as any)
  return isCancel(value) ? BACK : String(value ?? '').trim()
}

async function promptConfirm(options: Parameters<typeof confirm>[0]): Promise<boolean | Back> {
  const value = await confirm(options as any)
  return isCancel(value) ? BACK : Boolean(value)
}

function listSystemUsers(): SystemUser[] {
  const users: SystemUser[] = []
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
    ? [...ALL_THINKING_LEVELS]
    : ['off', 'minimal', 'low', 'medium', 'high']
}

async function loadInstallerAgentContext(): Promise<InstallerAgentContext> {
  const builtinChoices: ModelChoice[] = []
  for (const provider of getProviders()) {
    for (const model of getModels(provider as any)) {
      builtinChoices.push({
        provider: String((model as any).provider || provider),
        id: String((model as any).id || ''),
        reasoning: Boolean((model as any).reasoning),
        available: false,
      })
    }
  }

  const byKey = new Map<string, ModelChoice>(builtinChoices.map((choice) => [`${choice.provider}/${choice.id}`, choice]))
  let authStorage: any | null = null

  try {
    const runtimeProfile = resolveRuntimeProfile()
    const session = await createConfiguredAgentSession({ cwd: runtimeProfile.cwd, agentDir: runtimeProfile.agentDir })
    const registry = (session as any).modelRegistry
    authStorage = registry?.authStorage || null
    const all = Array.isArray(registry?.getAll?.()) ? registry.getAll() : []
    const availableKeys = new Set(
      (Array.isArray(registry?.getAvailable?.()) ? registry.getAvailable() : []).map((model: any) => `${model.provider}/${model.id}`),
    )

    for (const model of all) {
      const key = `${model.provider}/${model.id}`
      byKey.set(key, {
        provider: String(model.provider || ''),
        id: String(model.id || ''),
        reasoning: Boolean(model.reasoning),
        available: availableKeys.has(key),
      })
    }
  } catch {}

  const models = [...byKey.values()].filter((choice) => choice.provider && choice.id)
  models.sort((a, b) => a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id))
  return { models, authStorage }
}

async function chooseTargetUser(currentUser: string): Promise<TargetUserPlan | Back> {
  const allUsers = listSystemUsers()
  const otherUsers = allUsers.filter((entry) => entry.name !== currentUser)

  while (true) {
    const targetMode = await promptSelect<string>({
      message: 'Choose the target user for the Rin daemon.',
      options: [
        { value: 'current', label: 'Current user', hint: currentUser },
        { value: 'existing', label: 'Existing other user', hint: otherUsers.length ? `${otherUsers.length} user(s)` : 'none found' },
        { value: 'new', label: 'New user', hint: 'enter a username' },
      ],
    })
    if (isBack(targetMode)) return BACK

    if (targetMode === 'current') return { targetUser: currentUser, targetMode }

    if (targetMode === 'existing') {
      if (!otherUsers.length) {
        note('No eligible existing users were found on this system.', 'Target user')
        continue
      }
      const targetUser = await promptSelect<string>({
        message: 'Choose the existing user to host the Rin daemon.',
        options: otherUsers.map((entry) => ({ value: entry.name, label: entry.name, hint: `${entry.home} · uid ${entry.uid}` })),
      })
      if (isBack(targetUser)) continue
      return { targetUser, targetMode }
    }

    const targetUser = await promptText({
      message: 'Enter the new username to create for the Rin daemon.',
      placeholder: 'rin',
      validate(value) {
        const next = String(value || '').trim()
        if (!next) return 'Username is required.'
        if (!/^[a-z_][a-z0-9_-]*[$]?$/i.test(next)) return 'Use a normal Unix username.'
      },
    })
    if (isBack(targetUser)) continue
    return { targetUser, targetMode }
  }
}

async function chooseInstallDir(targetUser: string): Promise<string | Back> {
  const defaultDir = path.join(targetHomeForUser(targetUser), '.rin')
  const installDir = await promptText({
    message: 'Choose the Rin data directory for the daemon user.',
    placeholder: defaultDir,
    defaultValue: defaultDir,
    validate(value) {
      const next = String(value || '').trim()
      if (!next) return 'Directory is required.'
      if (!path.isAbsolute(next)) return 'Use an absolute path.'
    },
  })
  if (isBack(installDir)) return BACK

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

  return installDir
}

async function maybeLoginProvider(provider: string, authStorage: any | null): Promise<{ back?: true; hasAuth: boolean }> {
  const status = spinner()
  status.start(`Checking auth for ${provider}...`)

  if (!authStorage?.getOAuthProviders) {
    status.stop(`No auth storage is available for ${provider} in this installer environment.`)
    return { hasAuth: false }
  }

  if (authStorage.hasAuth?.(provider)) {
    status.stop(`${provider} is already authenticated.`)
    return { hasAuth: true }
  }

  const oauthProvider = authStorage.getOAuthProviders().find((entry: any) => entry.id === provider)
  if (!oauthProvider) {
    status.stop(`${provider} needs manual configuration later.`)
    note([
      `Provider: ${provider}`,
      'This provider does not expose a built-in OAuth flow here.',
      'You can still configure it later with auth.json, environment variables, or custom provider config.',
    ].join('\n'), 'Provider auth')
    return { hasAuth: false }
  }

  let lastAuthUrl = ''
  status.start(`Starting login for ${oauthProvider.name || provider}...`)

  try {
    await authStorage.login(provider, {
      onAuth(info: { url: string; instructions?: string }) {
        lastAuthUrl = String(info?.url || '')
        status.stop(`Open this URL to continue login:\n${lastAuthUrl}${info?.instructions ? `\n${info.instructions}` : ''}`)
      },
      async onPrompt(prompt: { message: string; placeholder?: string }) {
        const value = await promptText({
          message: prompt.message || 'Enter login value.',
          placeholder: prompt.placeholder,
          validate(input) {
            if (!String(input || '').trim()) return 'A value is required.'
          },
        })
        if (isBack(value)) throw new Error('rin_installer_back')
        return value
      },
      onProgress(message: string) {
        status.message(message || `Waiting for ${oauthProvider.name || provider} login...`)
      },
      async onManualCodeInput() {
        const value = await promptText({
          message: 'Paste the redirect URL or code from the browser.',
          placeholder: lastAuthUrl ? 'paste the final redirect URL or device code' : 'paste the code',
          validate(input) {
            if (!String(input || '').trim()) return 'A value is required.'
          },
        })
        if (isBack(value)) throw new Error('rin_installer_back')
        return value
      },
      signal: AbortSignal.timeout(10 * 60 * 1000),
    })
    status.stop(`${oauthProvider.name || provider} login complete.`)
    return { hasAuth: true }
  } catch (error: any) {
    if (String(error?.message || error) === 'rin_installer_back') {
      status.stop(`Login for ${oauthProvider.name || provider} cancelled.`)
      return { back: true, hasAuth: false }
    }
    status.stop(`Login failed for ${oauthProvider.name || provider}.`)
    note(String(error?.message || error || 'provider_login_failed'), 'Provider auth')
    return { hasAuth: Boolean(authStorage.hasAuth?.(provider)) }
  }
}

async function chooseModelConfig(): Promise<ModelPlan | Back> {
  const load = spinner()
  load.start('Loading provider and model choices...')
  const context = await loadInstallerAgentContext().catch(() => ({ models: [] as ModelChoice[], authStorage: null }))
  load.stop(context.models.length ? 'Provider and model choices loaded.' : 'No provider/model choices were loaded.')
  const models = context.models
  const providerNames = [...new Set(models.map((model) => model.provider).filter(Boolean))]

  if (!providerNames.length) throw new Error('rin_installer_no_models_available')

  while (true) {
    const provider = await promptSelect<string>({
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
    })
    if (isBack(provider)) return BACK

    const auth = await maybeLoginProvider(provider, context.authStorage)
    if (auth.back) continue

    const providerModels = models.filter((model) => model.provider === provider)
    if (!providerModels.length) throw new Error(`rin_installer_no_models_for_provider:${provider}`)

    while (true) {
      const modelId = await promptSelect<string>({
        message: 'Choose a model.',
        options: providerModels.map((model) => ({
          value: model.id,
          label: model.id,
          hint: [auth.hasAuth || model.available ? 'ready' : 'needs auth/config', model.reasoning ? 'reasoning' : 'no reasoning'].join(' · '),
        })),
      })
      if (isBack(modelId)) break

      const model = providerModels.find((entry) => entry.id === modelId)!
      const thinkingLevel = await promptSelect<string>({
        message: 'Choose the default thinking level.',
        options: computeAvailableThinkingLevels(model).map((level) => ({ value: level, label: level })),
      })
      if (isBack(thinkingLevel)) continue

      return { provider, modelId, thinkingLevel, modelAvailable: auth.hasAuth || model.available }
    }
  }
}

async function chooseKoishiPlan(): Promise<KoishiPlan | Back> {
  const enable = await promptConfirm({ message: 'Configure a Koishi adapter now?', initialValue: false })
  if (isBack(enable)) return BACK
  if (!enable) return { enabled: false }

  const adapter = await promptSelect<'telegram' | 'onebot'>({
    message: 'Choose a Koishi adapter.',
    options: [
      { value: 'telegram', label: 'Telegram', hint: 'bot token' },
      { value: 'onebot', label: 'OneBot', hint: 'endpoint URL' },
    ],
  })
  if (isBack(adapter)) return BACK

  if (adapter === 'telegram') {
    const token = await promptText({
      message: 'Enter the Telegram bot token.',
      placeholder: '123456:ABCDEF...',
      validate(value) {
        if (!String(value || '').trim()) return 'Token is required.'
      },
    })
    if (isBack(token)) return BACK
    return { enabled: true, adapter, token }
  }

  const endpoint = await promptText({
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
  })
  if (isBack(endpoint)) return BACK
  return { enabled: true, adapter, endpoint }
}

export async function startInstaller() {
  const currentUser = os.userInfo().username
  intro('Rin Installer')

  let target: TargetUserPlan | undefined
  let installDir: string | undefined
  let model: ModelPlan | undefined
  let koishi: KoishiPlan | undefined
  let step = 0

  while (true) {
    if (step === 0) {
      const result = await chooseTargetUser(currentUser)
      if (isBack(result)) {
        cancel('Installer cancelled.')
        return
      }
      target = result
      step = 1
      continue
    }

    if (step === 1) {
      const result = await chooseInstallDir(target!.targetUser)
      if (isBack(result)) {
        step = 0
        continue
      }
      installDir = result
      step = 2
      continue
    }

    if (step === 2) {
      const result = await chooseModelConfig()
      if (isBack(result)) {
        step = 1
        continue
      }
      model = result
      step = 3
      continue
    }

    if (step === 3) {
      const result = await chooseKoishiPlan()
      if (isBack(result)) {
        step = 2
        continue
      }
      koishi = result
      break
    }
  }

  note([
    `Current user: ${currentUser}`,
    `Target daemon user: ${target!.targetUser}`,
    `Target mode: ${target!.targetMode}`,
    `Install dir: ${installDir!}`,
    `Provider: ${model!.provider}`,
    `Model: ${model!.modelId}`,
    `Thinking level: ${model!.thinkingLevel}`,
    `Model auth status: ${model!.modelAvailable ? 'ready' : 'needs auth/config later'}`,
    `Koishi: ${koishi!.enabled ? koishi!.adapter : 'disabled for now'}`,
    koishi!.enabled && koishi!.adapter === 'telegram' ? 'Koishi token: [saved later during real install]' : '',
    koishi!.enabled && koishi!.adapter === 'onebot' ? `Koishi endpoint: ${koishi!.endpoint}` : '',
    '',
    'Planned command shape:',
    '- `rin` → RPC TUI for the target user',
    '- `rin --std` → std TUI for the target user',
    '- `rin --tmux <session_name>` → attach/create a hidden Rin tmux session for the target user',
    '- `rin --tmux-list` → list Rin tmux sessions for the target user',
    '',
    'This installer is still a dry run. Nothing has been installed yet.',
  ].filter(Boolean).join('\n'), 'Install plan')

  outro('Installer placeholder complete. No changes were made.')
}
