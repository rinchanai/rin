#!/usr/bin/env node
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'

import { cancel, confirm, intro, isCancel, note, outro, select, spinner, text } from '@clack/prompts'

import { loadRinCodingAgent } from '../rin-lib/loader.js'

function listSystemUsers() {
  const users: Array<{ name: string; uid: number; gid: number; home: string; shell: string }> = []
  try {
    const raw = fs.readFileSync('/etc/passwd', 'utf8')
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim() || line.startsWith('#')) continue
      const [name = '', , uidRaw = '', gidRaw = '', , home = '', shell = ''] = line.split(':')
      const uid = Number(uidRaw || 0)
      const gid = Number(gidRaw || 0)
      if (!name) continue
      if (!Number.isFinite(uid) || !Number.isFinite(gid)) continue
      if (uid < 1000) continue
      if (name === 'nobody') continue
      if (/nologin|false/.test(shell)) continue
      users.push({ name, uid, gid, home, shell } as any)
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

function findSystemUser(targetUser: string) {
  return listSystemUsers().find((entry) => entry.name === targetUser)
}

function targetHomeForUser(targetUser: string) {
  const matched = findSystemUser(targetUser)
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

function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true })
}

function readJsonFile<T>(filePath: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T
  } catch {
    return fallback
  }
}

function writeJsonFile(filePath: string, value: unknown) {
  ensureDir(path.dirname(filePath))
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
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

  const choices = [...merged.values()].filter((model) => model.provider && model.id)
  choices.sort((a, b) => a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id))
  return choices
}

async function createInstallerAuthStorage(installDir: string) {
  const codingAgentModule = await loadRinCodingAgent()
  const { AuthStorage } = codingAgentModule as any
  return AuthStorage.create(path.join(installDir, 'auth.json'))
}

async function configureProviderAuth(provider: string, installDir: string) {
  ensureDir(installDir)
  const authStorage = await createInstallerAuthStorage(installDir)
  if (authStorage.hasAuth?.(provider)) {
    return { available: true, authKind: 'existing' }
  }

  const oauthProviders = Array.isArray(authStorage.getOAuthProviders?.()) ? authStorage.getOAuthProviders() : []
  const oauthProvider = oauthProviders.find((entry: any) => entry.id === provider)

  if (oauthProvider) {
    const loginSpinner = spinner()
    let lastAuthUrl = ''
    loginSpinner.start(`Starting ${oauthProvider.name || provider} login...`)
    try {
      await authStorage.login(provider, {
        onAuth(info: { url: string; instructions?: string }) {
          lastAuthUrl = String(info?.url || '')
          loginSpinner.stop(`Open this URL to continue login:\n${lastAuthUrl}${info?.instructions ? `\n${info.instructions}` : ''}`)
        },
        async onPrompt(prompt: { message: string; placeholder?: string }) {
          return String(ensureNotCancelled(await text({
            message: prompt.message || 'Enter login value.',
            placeholder: prompt.placeholder,
            validate(value) {
              if (!String(value || '').trim()) return 'A value is required.'
            },
          }))).trim()
        },
        onProgress(message: string) {
          loginSpinner.message(message || `Waiting for ${oauthProvider.name || provider} login...`)
        },
        async onManualCodeInput() {
          return String(ensureNotCancelled(await text({
            message: 'Paste the redirect URL or code from the browser.',
            placeholder: lastAuthUrl ? 'paste the final redirect URL or device code' : 'paste the code',
            validate(value) {
              if (!String(value || '').trim()) return 'A value is required.'
            },
          }))).trim()
        },
        signal: AbortSignal.timeout(10 * 60 * 1000),
      })
      loginSpinner.stop(`${oauthProvider.name || provider} login complete.`)
      return { available: true, authKind: 'oauth' }
    } catch (error: any) {
      loginSpinner.stop(`Login failed for ${oauthProvider.name || provider}.`)
      throw error
    }
  }

  const token = String(ensureNotCancelled(await text({
    message: `Enter the API key or token for ${provider}.`,
    placeholder: 'token',
    validate(value) {
      if (!String(value || '').trim()) return 'A token is required.'
    },
  }))).trim()
  authStorage.set(provider, { type: 'api_key', key: token })
  return { available: true, authKind: 'api_key' }
}

function describeOwnership(targetUser: string, installDir: string) {
  const target = findSystemUser(targetUser) as any
  const targetUid = Number(target?.uid ?? -1)
  const targetGid = Number(target?.gid ?? -1)

  try {
    const stat = fs.statSync(installDir)
    let writable = true
    try {
      fs.accessSync(installDir, fs.constants.W_OK)
    } catch {
      writable = false
    }
    return {
      ownerMatches: targetUid >= 0 ? stat.uid === targetUid : true,
      writable,
      statUid: stat.uid,
      statGid: stat.gid,
      targetUid,
      targetGid,
    }
  } catch {
    return {
      ownerMatches: true,
      writable: true,
      statUid: -1,
      statGid: -1,
      targetUid,
      targetGid,
    }
  }
}

async function persistInstallerOutputs(options: {
  currentUser: string
  targetUser: string
  installDir: string
  provider: string
  modelId: string
  thinkingLevel: string
  koishiDescription: string
  koishiDetail: string
  koishiConfig: any
}) {
  ensureDir(options.installDir)

  const codingAgentModule = await loadRinCodingAgent()
  const { SettingsManager } = codingAgentModule as any
  const targetCwd = targetHomeForUser(options.targetUser)
  const settingsManager = SettingsManager.create(targetCwd, options.installDir)
  settingsManager.setDefaultModelAndProvider(options.provider, options.modelId)
  settingsManager.setDefaultThinkingLevel(options.thinkingLevel)

  const settingsPath = path.join(options.installDir, 'settings.json')
  const settingsJson = readJsonFile<any>(settingsPath, {})
  if (options.koishiConfig) {
    settingsJson.koishi ||= {}
    if (options.koishiConfig.telegram) settingsJson.koishi.telegram = options.koishiConfig.telegram
    if (options.koishiConfig.onebot) settingsJson.koishi.onebot = options.koishiConfig.onebot
  }
  writeJsonFile(settingsPath, settingsJson)

  const launcherPath = path.join(os.homedir(), '.config', 'rin', 'install.json')
  const launcherJson = readJsonFile<any>(launcherPath, {})
  launcherJson.defaultTargetUser = options.targetUser
  launcherJson.defaultInstallDir = options.installDir
  launcherJson.updatedAt = new Date().toISOString()
  launcherJson.installedBy = options.currentUser
  writeJsonFile(launcherPath, launcherJson)

  const manifestPath = path.join(options.installDir, 'config', 'installer.json')
  const manifestJson = readJsonFile<any>(manifestPath, {})
  manifestJson.targetUser = options.targetUser
  manifestJson.installDir = options.installDir
  manifestJson.defaultProvider = options.provider
  manifestJson.defaultModel = options.modelId
  manifestJson.defaultThinkingLevel = options.thinkingLevel
  manifestJson.koishi = options.koishiConfig || {}
  manifestJson.updatedAt = new Date().toISOString()
  writeJsonFile(manifestPath, manifestJson)

  return { settingsPath, launcherPath, manifestPath }
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

  const loadSpinner = spinner()
  loadSpinner.start('Loading provider and model choices...')
  const models = await loadModelChoices()
  loadSpinner.stop('Provider and model choices loaded.')

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

  const authResult = await configureProviderAuth(String(provider), installDir)

  const providerModels = models.filter((model) => model.provider === provider)
  if (!providerModels.length) {
    throw new Error(`rin_installer_no_models_for_provider:${provider}`)
  }
  const modelId = ensureNotCancelled(await select({
    message: 'Choose a model.',
    options: providerModels.map((model) => ({
      value: model.id,
      label: model.id,
      hint: [authResult.available || model.available ? 'ready' : 'needs auth/config', model.reasoning ? 'reasoning' : 'no reasoning'].join(' · '),
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
  let koishiConfig: any = null
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
      const token = String(ensureNotCancelled(await text({
        message: 'Enter the Telegram bot token.',
        placeholder: '123456:ABCDEF...',
        validate(value) {
          if (!String(value || '').trim()) return 'Token is required.'
        },
      }))).trim()
      koishiDetail = 'Koishi token: [saved to target settings.json]'
      koishiConfig = { telegram: { token, protocol: 'polling', slash: true } }
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
      koishiConfig = { onebot: { endpoint, protocol: endpoint.startsWith('ws') ? 'ws' : 'http', selfId: '', token: '' } }
    }
  }

  note([
    `Current user: ${currentUser}`,
    `Target daemon user: ${targetUser}`,
    `Install dir: ${installDir}`,
    `Provider: ${provider}`,
    `Model: ${modelId}`,
    `Thinking level: ${thinkingLevel}`,
    `Model auth status: ${authResult.available || model.available ? 'ready' : 'needs auth/config later'}`,
    `Koishi: ${koishiDescription}`,
    koishiDetail,
    '',
    'Planned command shape:',
    '- `rin` → RPC TUI for the target user',
    '- `rin --std` → std TUI for the target user',
    '- `rin --tmux <session_name>` → attach/create a hidden Rin tmux session for the target user',
    '- `rin --tmux-list` → list Rin tmux sessions for the target user',
    '',
    'Safety reminder:',
    '- This agent runs with the full permissions of its system user account.',
    '- Treat it like a shell-capable operator on that account and use it carefully.',
  ].filter(Boolean).join('\n'), 'Install plan')

  const ownership = describeOwnership(targetUser, installDir)
  if (!ownership.ownerMatches && ownership.targetUid >= 0) {
    note([
      `Target dir owner uid/gid: ${ownership.statUid}:${ownership.statGid}`,
      `Target user uid/gid: ${ownership.targetUid}:${ownership.targetGid}`,
      'This directory is not currently owned by the selected target user.',
      'The installer will still write config if it can, but you may want to fix ownership before switching fully.',
    ].join('\n'), 'Ownership check')
  }

  if (!ownership.writable) {
    note('The selected install directory is not writable by the current installer process.', 'Ownership check')
  }

  const shouldWrite = ensureNotCancelled(await confirm({
    message: 'Write these settings now?',
    initialValue: true,
  }))

  if (!shouldWrite) {
    outro('Installer finished without writing changes.')
    return
  }

  const written = await persistInstallerOutputs({
    currentUser,
    targetUser,
    installDir,
    provider: String(provider),
    modelId: String(modelId),
    thinkingLevel: String(thinkingLevel),
    koishiDescription,
    koishiDetail,
    koishiConfig,
  })

  note([
    `Target install dir: ${installDir}`,
    `Written: ${written.settingsPath}`,
    `Written: ${path.join(installDir, 'auth.json')}`,
    `Written: ${written.manifestPath}`,
    `Written: ${written.launcherPath}`,
    '',
    'Default launcher behavior:',
    '- `rin` uses the saved target user and install dir',
    '- `rin --std` enters std mode for that target',
    '- `rin -t <name>` attaches/creates a hidden tmux TUI session',
    '',
    'Safety reminder:',
    '- This agent runs with the full permissions of its system user account.',
    '- Treat it like a shell-capable operator on that account and use it carefully.',
  ].join('\n'), 'Written paths')

  outro(`Installer wrote config for ${targetUser}. You can start with: rin, rin --std, rin -t main`)
}

