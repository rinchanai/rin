import path from 'node:path'

import { configureProviderAuth, computeAvailableThinkingLevels, loadModelChoices } from './provider-auth.js'

export type PromptApi = {
  ensureNotCancelled: <T>(value: T | symbol) => T
  select: (options: any) => Promise<any>
  text: (options: any) => Promise<any>
  confirm: (options: any) => Promise<any>
}

export type SystemUser = { name: string; uid: number; gid: number; home: string; shell: string }

export async function promptTargetInstall(prompt: PromptApi, currentUser: string, allUsers: SystemUser[], targetHomeForUser: (user: string) => string) {
  const otherUsers = allUsers.filter((entry) => entry.name !== currentUser)
  const existingCandidates = otherUsers.length ? otherUsers : allUsers.filter((entry) => entry.name !== currentUser).length ? allUsers.filter((entry) => entry.name !== currentUser) : allUsers

  const targetMode = prompt.ensureNotCancelled(await prompt.select({
    message: 'Choose the target user for the Rin daemon.',
    options: [
      { value: 'current', label: 'Current user', hint: currentUser },
      { value: 'existing', label: 'Existing other user', hint: existingCandidates.length ? `${existingCandidates.length} user(s)` : 'none found' },
      { value: 'new', label: 'New user', hint: 'enter a username' },
    ],
  }))

  let targetUser = currentUser
  if (targetMode === 'existing') {
    if (!existingCandidates.length) {
      return {
        cancelled: true as const,
        targetUser,
        existingCandidates,
        allUsers,
      }
    }
    targetUser = prompt.ensureNotCancelled(await prompt.select({
      message: 'Choose the existing user to host the Rin daemon.',
      options: existingCandidates.map((entry) => ({
        value: entry.name,
        label: entry.name,
        hint: `${entry.home} · uid ${entry.uid}`,
      })),
    }))
  } else if (targetMode === 'new') {
    targetUser = prompt.ensureNotCancelled(await prompt.text({
      message: 'Enter the new username to create for the Rin daemon.',
      placeholder: 'rin',
      validate(value: string) {
        const next = String(value || '').trim()
        if (!next) return 'Username is required.'
        if (!/^[a-z_][a-z0-9_-]*[$]?$/i.test(next)) return 'Use a normal Unix username.'
      },
    }))
  }

  const defaultDir = path.join(targetHomeForUser(targetUser), '.rin')
  const installDir = String(prompt.ensureNotCancelled(await prompt.text({
    message: 'Choose the Rin data directory for the daemon user.',
    placeholder: defaultDir,
    defaultValue: defaultDir,
    validate(value: string) {
      const next = String(value || '').trim()
      if (!next) return 'Directory is required.'
      if (!path.isAbsolute(next)) return 'Use an absolute path.'
    },
  }))).trim()

  return { cancelled: false as const, targetUser, installDir, defaultDir, existingCandidates, allUsers }
}

export function describeInstallDirState(installDir: string, state: { exists: boolean; entryCount: number; sample: string[] }) {
  if (state.exists) {
    return {
      title: 'Existing directory',
      text: [
        `Directory exists: ${installDir}`,
        `Existing entries: ${state.entryCount}`,
        state.sample.length ? `Sample: ${state.sample.join(', ')}` : '',
        '',
        'Installer policy:',
        '- keep unknown files untouched',
        '- keep existing config unless a required file must be updated',
        '- only remove old files when they are known legacy Rin artifacts',
      ].filter(Boolean).join('\n'),
    }
  }
  return {
    title: 'Install directory',
    text: [
      `Directory will be created: ${installDir}`,
      '',
      'Installer policy:',
      '- create only the files Rin needs',
      '- future updates should preserve unknown files',
    ].join('\n'),
  }
}

export async function promptProviderSetup(prompt: PromptApi, installDir: string, readJsonFile: <T>(filePath: string, fallback: T) => T) {
  const shouldConfigureProvider = prompt.ensureNotCancelled(await prompt.confirm({
    message: 'Configure a provider now?',
    initialValue: true,
  }))

  let provider = ''
  let modelId = ''
  let thinkingLevel = ''
  let authResult: any = { available: false, authKind: 'skipped', authData: {} }

  if (!shouldConfigureProvider) return { provider, modelId, thinkingLevel, authResult }

  const models = await loadModelChoices()
  const providerNames = [...new Set(models.map((model) => model.provider).filter(Boolean))]
  if (!providerNames.length) throw new Error('rin_installer_no_models_available')

  provider = String(prompt.ensureNotCancelled(await prompt.select({
    message: 'Choose a provider to authenticate and use.',
    options: providerNames.map((name) => {
      const scoped = models.filter((model) => model.provider === name)
      const availableCount = scoped.filter((model) => model.available).length
      return {
        value: name,
        label: name,
        hint: availableCount ? `${availableCount}/${scoped.length} ready` : `${scoped.length} models`,
      }
    }),
  })))

  authResult = await configureProviderAuth(String(provider), installDir, {
    readJsonFile,
    ensureNotCancelled: prompt.ensureNotCancelled,
  })

  const providerModels = models.filter((model) => model.provider === provider)
  if (!providerModels.length) throw new Error(`rin_installer_no_models_for_provider:${provider}`)
  modelId = String(prompt.ensureNotCancelled(await prompt.select({
    message: 'Choose a model.',
    options: providerModels.map((model) => ({
      value: model.id,
      label: model.id,
      hint: [authResult.available || model.available ? 'ready' : 'needs auth/config', model.reasoning ? 'reasoning' : 'no reasoning'].join(' · '),
    })),
  })))

  const model = providerModels.find((entry) => entry.id === modelId)!
  thinkingLevel = String(prompt.ensureNotCancelled(await prompt.select({
    message: 'Choose the default thinking level.',
    options: computeAvailableThinkingLevels(model).map((level) => ({ value: level, label: level })),
  })))

  return { provider, modelId, thinkingLevel, authResult }
}

export async function promptKoishiSetup(prompt: PromptApi) {
  const enableKoishi = prompt.ensureNotCancelled(await prompt.confirm({
    message: 'Configure a Koishi adapter now?',
    initialValue: false,
  }))

  let koishiDescription = 'disabled for now'
  let koishiDetail = ''
  let koishiConfig: any = null
  if (!enableKoishi) return { koishiDescription, koishiDetail, koishiConfig }

  const adapter = prompt.ensureNotCancelled(await prompt.select({
    message: 'Choose a Koishi adapter.',
    options: [
      { value: 'telegram', label: 'Telegram', hint: 'bot token' },
      { value: 'onebot', label: 'OneBot', hint: 'endpoint URL' },
    ],
  })) as 'telegram' | 'onebot'

  koishiDescription = adapter
  if (adapter === 'telegram') {
    const token = String(prompt.ensureNotCancelled(await prompt.text({
      message: 'Enter the Telegram bot token.',
      placeholder: '123456:ABCDEF...',
      validate(value: string) {
        if (!String(value || '').trim()) return 'Token is required.'
      },
    }))).trim()
    koishiDetail = 'Koishi token: [saved to target settings.json]'
    koishiConfig = { telegram: { token, protocol: 'polling', slash: true } }
  } else {
    const endpoint = String(prompt.ensureNotCancelled(await prompt.text({
      message: 'Enter the OneBot endpoint URL.',
      placeholder: 'http://127.0.0.1:5700',
      validate(value: string) {
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

  return { koishiDescription, koishiDetail, koishiConfig }
}

export function buildInstallPlanText(options: {
  currentUser: string
  targetUser: string
  installDir: string
  provider: string
  modelId: string
  thinkingLevel: string
  authAvailable: boolean
  koishiDescription: string
  koishiDetail: string
}) {
  const { currentUser, targetUser, installDir, provider, modelId, thinkingLevel, authAvailable, koishiDescription, koishiDetail } = options
  return [
    `Current user: ${currentUser}`,
    `Target daemon user: ${targetUser}`,
    `Install dir: ${installDir}`,
    `Provider: ${provider || 'skipped for now'}`,
    `Model: ${modelId || 'skipped for now'}`,
    `Thinking level: ${thinkingLevel || 'skipped for now'}`,
    `Model auth status: ${provider ? (authAvailable ? 'ready' : 'needs auth/config later') : 'skipped for now'}`,
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
  ].filter(Boolean).join('\n')
}

export function buildFinalRequirements(options: {
  installServiceNow: boolean
  needsElevatedWrite: boolean
  needsElevatedService: boolean
}) {
  return [
    'write configuration and launchers',
    'publish the runtime into the install directory',
    options.installServiceNow ? 'install and start the daemon service' : 'skip daemon service installation on this platform',
    options.needsElevatedWrite || options.needsElevatedService
      ? 'use sudo/doas if needed for the selected target and install dir'
      : 'no extra privilege escalation currently predicted',
  ]
}
