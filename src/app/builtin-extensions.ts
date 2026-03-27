import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * App-level builtin extension manifest.
 *
 * These extensions are standard pi extensions under /extensions,
 * but the app build force-loads them so users do not have to configure
 * or install them manually.
 */
function repoRootFromHere() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
}

export function getBuiltinExtensionPaths() {
  const root = repoRootFromHere()
  return [
    path.join(root, 'extensions', 'discover-attention-resources', 'index.ts'),
    path.join(root, 'extensions', 'web-search', 'index.ts'),
    path.join(root, 'extensions', 'reset-system-prompt', 'index.ts'),
    path.join(root, 'extensions', 'freeze-session-runtime', 'index.ts'),
  ]
}
