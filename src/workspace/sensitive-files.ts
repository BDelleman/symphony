import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export type SensitiveWorkspaceFileCategory =
  | 'dotenv'
  | 'agent_auth_store'
  | 'package_manager_auth'
  | 'cloud_credentials'
  | 'ssh_credentials'
  | 'private_key_material'
  | 'symlink_escape';

export interface SensitiveWorkspaceFileViolation {
  path: string;
  category: SensitiveWorkspaceFileCategory;
  mode: string;
  absolutePath: string;
}

export interface SensitiveWorkspaceAudit {
  complete: boolean;
  scannedEntries: number;
  violations: SensitiveWorkspaceFileViolation[];
  error: string | null;
}

const SKIPPED_DIRECTORIES = new Set([
  '.git', '.hg', '.jj', '.svn'
]);

const DOTENV_TEMPLATE_NAMES = new Set(['.env.example', '.env.sample', '.env.template']);

function isCanonicalDotenvTemplate(base: string): boolean {
  return DOTENV_TEMPLATE_NAMES.has(base.toLowerCase());
}

function isTrackedUnmodifiedFile(absolutePath: string): boolean {
  const directory = path.dirname(absolutePath);
  const topLevel = spawnSync('git', ['-C', directory, 'rev-parse', '--show-toplevel'], {
    encoding: 'utf8', shell: false, timeout: 5_000, maxBuffer: 64 * 1024
  });
  if (topLevel.status !== 0) return false;
  const root = topLevel.stdout.trim();
  const relative = path.relative(root, absolutePath).replace(/\\/g, '/');
  if (!relative || relative.startsWith('../') || path.isAbsolute(relative)) return false;
  const tracked = spawnSync('git', ['-C', root, 'ls-files', '--error-unmatch', '--', relative], {
    encoding: 'utf8', shell: false, timeout: 5_000, maxBuffer: 64 * 1024
  });
  if (tracked.status !== 0) return false;
  const unchanged = spawnSync('git', ['-C', root, 'diff', '--quiet', 'HEAD', '--', relative], {
    encoding: 'utf8', shell: false, timeout: 5_000, maxBuffer: 64 * 1024
  });
  return unchanged.status === 0;
}

function classifySensitivePath(
  relativePath: string,
  isDirectory: boolean,
  absolutePath?: string
): SensitiveWorkspaceFileCategory | null {
  const normalized = relativePath.replace(/\\/g, '/');
  const segments = normalized.split('/').filter(Boolean);
  const lowerSegments = segments.map((segment) => segment.toLowerCase());
  const base = lowerSegments.at(-1) ?? '';

  if (base === '.env' || base.startsWith('.env.')) {
    if (!isDirectory && isCanonicalDotenvTemplate(base) && absolutePath && isTrackedUnmodifiedFile(absolutePath)) {
      return null;
    }
    return 'dotenv';
  }
  if (base === '.claude.json' || base === '.mcp.json') return 'agent_auth_store';
  if (['.npmrc', '.pnpmrc', '.yarnrc', '.yarnrc.yml', '.pypirc', '.netrc', '.authinfo', '.git-credentials'].includes(base)) {
    return 'package_manager_auth';
  }
  if (
    lowerSegments.includes('.cargo') ||
    lowerSegments.includes('.composer') ||
    (lowerSegments.includes('.config') && (lowerSegments.includes('pip') || lowerSegments.includes('pypoetry')))
  ) return 'package_manager_auth';
  if (lowerSegments.includes('.ssh')) {
    if (isDirectory && base === '.ssh') return 'ssh_credentials';
    if (/^id_[a-z0-9_-]+$/.test(base) && !base.endsWith('.pub')) return 'ssh_credentials';
  }
  if (
    lowerSegments.includes('.aws') ||
    lowerSegments.includes('.azure') ||
    lowerSegments.includes('.kube') ||
    lowerSegments.includes('.gnupg') ||
    lowerSegments.includes('.docker') ||
    lowerSegments.includes('.terraform.d') ||
    (lowerSegments.includes('.config') && (
      lowerSegments.includes('gh') ||
      lowerSegments.includes('gcloud') ||
      lowerSegments.includes('containers')
    )) ||
    base === 'credentials' ||
    base === 'credentials.json' ||
    /service-account.*\.json$/i.test(base)
  ) {
    return 'cloud_credentials';
  }
  if (!isDirectory && (/\.(pem|key|p12|pfx)$/i.test(base) || /^id_[a-z0-9_-]+$/i.test(base))) {
    return 'private_key_material';
  }
  return null;
}

export function auditSensitiveWorkspaceFiles(
  workspaceRoot: string,
  options: { maxEntries?: number } = {}
): SensitiveWorkspaceAudit {
  const root = path.resolve(workspaceRoot);
  if (!fs.existsSync(root)) {
    return { complete: true, scannedEntries: 0, violations: [], error: null };
  }

  const maxEntries = options.maxEntries ?? 250_000;
  const violations: SensitiveWorkspaceFileViolation[] = [];
  const pending = [''];
  let scannedEntries = 0;
  try {
    while (pending.length > 0) {
      const relativeDirectory = pending.pop()!;
      const absoluteDirectory = relativeDirectory ? path.join(root, relativeDirectory) : root;
      for (const entry of fs.readdirSync(absoluteDirectory, { withFileTypes: true })) {
        scannedEntries += 1;
        if (scannedEntries > maxEntries) {
          return {
            complete: false,
            scannedEntries,
            violations,
            error: `workspace sensitive-file audit exceeded ${maxEntries} entries`
          };
        }
        const relativeEntry = relativeDirectory ? path.join(relativeDirectory, entry.name) : entry.name;
        const normalized = relativeEntry.replace(/\\/g, '/');
        const absoluteEntry = path.join(root, relativeEntry);
        const lstat = fs.lstatSync(absoluteEntry);
        if (lstat.isSymbolicLink()) {
          let resolvedTarget: string | null = null;
          try {
            resolvedTarget = fs.realpathSync(absoluteEntry);
          } catch {
            // Broken links are unsafe because their eventual target cannot be attested.
          }
          const relativeTarget = resolvedTarget ? path.relative(root, resolvedTarget) : '..';
          const escapesRoot = !resolvedTarget || relativeTarget.startsWith('..') || path.isAbsolute(relativeTarget);
          const targetCategory = resolvedTarget
            ? classifySensitivePath(path.relative(root, resolvedTarget), fs.statSync(resolvedTarget).isDirectory(), resolvedTarget)
            : null;
          if (escapesRoot || targetCategory) {
            const mode = (lstat.mode & 0o777).toString(8).padStart(4, '0');
            violations.push({
              path: normalized,
              category: targetCategory ?? 'symlink_escape',
              mode,
              absolutePath: absoluteEntry
            });
          }
          continue;
        }
        if (SKIPPED_DIRECTORIES.has(entry.name)) {
          continue;
        }
        const category = classifySensitivePath(relativeEntry, entry.isDirectory(), absoluteEntry);
        if (category) {
          const mode = (lstat.mode & 0o777).toString(8).padStart(4, '0');
          violations.push({ path: normalized, category, mode, absolutePath: absoluteEntry });
          if (entry.isDirectory()) continue;
        }
        if (entry.isDirectory() && !entry.isSymbolicLink()) pending.push(relativeEntry);
      }
    }
  } catch (error) {
    return {
      complete: false,
      scannedEntries,
      violations,
      error: error instanceof Error ? error.message : String(error)
    };
  }
  return { complete: true, scannedEntries, violations, error: null };
}
