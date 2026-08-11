import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
  PermissionAnalysis,
  PermissionCapability,
  PermissionRisk,
  PermissionRule,
  PermissionRuleScope,
} from '../../shared/types/permissionBroker';
import { canonicalizeProjectPath } from '../projects/ProjectService';

const SHELL_TOOLS = new Set(['bash', 'shell', 'powershell', 'cmd']);
const READ_TOOLS = new Set(['read', 'glob', 'grep', 'ls']);
const WRITE_TOOLS = new Set(['write', 'edit', 'multiedit', 'notebookedit']);
const NETWORK_TOOLS = new Set(['websearch', 'webfetch']);

const DESTRUCTIVE_PATTERNS = [
  /(?:^|[;&|]\s*)(?:sudo\s+)?rm\s+(?=[^;&|\r\n]*(?:-[^\s]*r|--recursive\b))/i,
  /(?:^|[;&|]\s*)(?:rmdir|rd)\b[^\r\n;&|]*\/s\b/i,
  /(?:^|[;&|]\s*)del\b[^\r\n;&|]*\/s\b/i,
  /(?:^|[;&|]\s*)(?:remove-item|ri)\b[^\r\n]*(?:-recurse|-r\b)/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean(?=\s|$)/i,
  /\bgit\s+push\b[^\r\n]*(?:--force(?:-with-lease)?|-f\b|--mirror|--prune)/i,
  /\bgit\s+push\b[^\r\n]*(?:--delete|-d)(?=\s|$)/i,
  /\bgit\s+push(?=\s|$)[^\r\n]*\s(?:\+|:)[^\s]+/i,
  /\bgit\s+checkout(?=\s|$)/i,
  /\bgit\s+(?:checkout|switch)\b[^\r\n]*(?:--force|-f|--discard-changes)(?=\s|$)/i,
  /\bgit\s+checkout\b[^\r\n]*\s--(?:\s|$)/i,
  /\bgit\s+stash\s+(?:drop|clear)(?=\s|$)/i,
  /\bgit\s+(?:branch|tag)\b[^\r\n]*(?:--delete|-[dD])(?=\s|$)/i,
  /\bgit\s+tag\b[^\r\n]*(?:--force|-f)(?=\s|$)/i,
  /\bgit\s+commit\b[^\r\n]*--amend(?=\s|$)/i,
  /^\s*find(?=\s)[^\r\n;&|]*(?:-delete|-execdir|-exec|-okdir|-ok|-fls|-fprint0?)(?=\s|$)/i,
  /^\s*robocopy(?=\s)[^\r\n;&|]*\/(?:mir|purge|mov|move)(?=\s|$)/i,
  /^\s*(?:cp|mv)(?=\s)[^\r\n;&|]*(?:\s-[A-Za-z]*f[A-Za-z]*(?=\s|$)|\s--(?:force|remove-destination)(?=\s|$))/i,
  /^\s*(?:copy|move|xcopy)(?=\s)[^\r\n;&|]*\/y(?=\s|$)/i,
  /(?:^|[;&|]\s*)(?:format|diskpart|shutdown|reboot|restart-computer)\b/i,
  /\b(?:npm|pnpm|yarn)\s+publish\b/i,
  /\b(?:cargo|dotnet|python\s+-m\s+twine)\s+publish\b/i,
];

const CREDENTIAL_PATTERNS = [
  /(?:^|[\\/])\.ssh[\\/](?:id_[^\s"']+|authorized_keys2?|config|known_hosts)/i,
  /(?:^|[\\/])\.aws[\\/](?:credentials|config)\b/i,
  /(?:^|[\\/])\.config[\\/](?:gcloud|gh)[\\/]/i,
  /(?:cookies|login data|local state|logins\.json|key4\.db|credential(?:s)?(?:\.json)?|keychain|secret(?:s)?\.json)/i,
  /(?:^|[\\/\s"'])\.env(?:\.[^\\/\s"']+)?(?:$|[\\/\s"'])/i,
  /(?:^|[\\/\s"'])(?:\.npmrc|\.pypirc|\.netrc|\.git-credentials)(?:$|[\\/\s"'])/i,
  /(?:^|[\\/\s"'])(?:\.gitconfig|\.bashrc|\.zshrc|\.profile|microsoft\.powershell_profile\.ps1)(?:$|[\\/\s"'])/i,
  /(?:^|[\\/\s"'])(?:id_rsa|id_dsa|id_ecdsa|id_ed25519|shadow)(?:$|[\\/\s"'])/i,
  /\.(?:pem|p12|pfx)(?:$|[\s"'])/i,
];

const GIT_METADATA_PATTERN = /(?:^|[\\/])\.git(?:$|[\\/])/i;
const SENSITIVE_BARE_PATH_PATTERN = /^(?:\.env(?:\.[^\\/\s"']+)?|\.npmrc|\.pypirc|\.netrc|\.git-credentials|\.gitconfig|\.bashrc|\.zshrc|\.profile|authorized_keys2?|microsoft\.powershell_profile\.ps1|logins\.json|key4\.db|local state|id_(?:rsa|dsa|ecdsa|ed25519)|shadow)$/i;
const SENSITIVE_DIRECTORY_PATTERN = /(?:^|[\\/])(?:\.ssh|\.aws|firefox[\\/]profiles|chrom(?:e|ium)[\\/]user data|\.config[\\/](?:gcloud|gh))(?:$|[\\/])/i;

const UNSAFE_NESTED_SHELL_PATTERNS = [
  /\$\(/,
  /`/,
  /[<>]\(/,
  /<<[-~]?\s*\w+/,
  /[\r\n]/,
  /(?<![>\d&])&(?![&\d])/,
  /(?:^|[\s;&|])(?:bash|sh|zsh|fish)\s+-c(?=\s|$)/i,
  /(?:^|[\s;&|])cmd(?:\.exe)?\s+\/(?:c|k)(?=\s|$)/i,
  /(?:^|[\s;&|])(?:powershell|pwsh)(?:\.exe)?(?=\s|$)[^\r\n]*(?:-(?:command|c|file)(?=\s|$))/i,
  /(?:^|[\s;&|])node(?=\s)[^\r\n;&|]*\s(?:--eval|--print|-e|-p)(?=\s|=|$)/i,
  /(?:^|[\s;&|])(?:python|python3|ruby|perl)(?=\s)[^\r\n;&|]*\s(?:-c|-e)(?=\s|$)/i,
  /(?:^|[\s;&|])(?:eval|invoke-expression|iex|source)(?=\s|$)/i,
];

const AMBIGUOUS_SHELL_PATH_PATTERNS = [
  /''|""/,
  /\$["']/,
  /`/,
  /\^/,
  /\$(?:[0-9@*#?!$-])(?=$|[^A-Za-z0-9_])/,
  /\{[^{}\r\n]*(?:,|\.\.)[^{}\r\n]*\}/,
  /[*?]/,
  /\[[^\]\r\n]+\]/,
  /\\[./~$'"\\]/,
  /(?:^|[\s=])~[^\\/\s"']+(?=$|[\\/\s;&|])/,
  /(?:^|[\s"'=])[A-Za-z]:[^\\/\s;&|]/,
  /(?:^|[;&|]\s*)(?:(?:cd|chdir|pushd)\s+|set-location\s+)(?:--|-|-[LP])(?=\s|$)/i,
];

const ELEVATION_PATTERNS = [
  /(?:^|[;&|]\s*)sudo\b/i,
  /\bstart-process\b[^\r\n]*-verb\s+runas\b/i,
  /\brunas(?:\.exe)?\b/i,
  /(?:powershell|pwsh)\b[^\r\n]*(?:-encodedcommand\b|-enc\b)/i,
];

const SAFE_PROJECT_CAPABILITIES = new Set<PermissionCapability>([
  'shell.read_only',
  'shell.build',
  'shell.test',
  'shell.git_read',
  'tool.read',
]);

const TASK_CACHEABLE_CAPABILITIES = new Set<PermissionCapability>([
  ...SAFE_PROJECT_CAPABILITIES,
  'shell.run_project',
  'shell.package_install',
  'shell.file_copy',
  'shell.file_write',
  'shell.git_mutation',
  'shell.network',
  'tool.write',
  'tool.network',
]);

const RISK_RANK: Record<PermissionRisk, number> = { low: 0, medium: 1, high: 2 };

const WRITE_EFFECT_CAPABILITIES = new Set<PermissionCapability>([
  'shell.build',
  'shell.test',
  'shell.run_project',
  'shell.package_install',
  'shell.file_copy',
  'shell.file_write',
  'shell.git_mutation',
  'shell.process_control',
  'shell.destructive',
  'tool.write',
]);

function canonicalCase(value: string): string {
  const normalized = path.normalize(value);
  return process.platform === 'win32'
    ? normalized.toLocaleLowerCase('en-US')
    : normalized;
}

function isContainedBy(root: string, candidate: string): boolean {
  const relative = path.relative(canonicalCase(root), canonicalCase(candidate));
  return relative === ''
    || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function expandPathVariables(value: string): string {
  let expanded = value.trim();
  expanded = expanded.replace(/^~(?=$|[\\/])/, osHome());
  expanded = expanded.replace(/%([^%]+)%/g, (match, name: string) => environmentValue(name) ?? match);
  expanded = expanded.replace(/\$\{([^}]+)\}/g, (match, name: string) => environmentValue(name) ?? match);
  expanded = expanded.replace(/\$env:([A-Za-z_][A-Za-z0-9_]*)/gi, (match, name: string) => (
    environmentValue(name) ?? match
  ));
  expanded = expanded.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (match, name: string) => (
    environmentValue(name) ?? match
  ));
  return expanded;
}

function environmentValue(name: string): string | undefined {
  const direct = process.env[name];
  if (direct !== undefined) return direct;
  const key = Object.keys(process.env).find((candidate) => (
    candidate.toLocaleLowerCase('en-US') === name.toLocaleLowerCase('en-US')
  ));
  return key ? process.env[key] : undefined;
}

function hasUnresolvedPathExpression(values: readonly string[]): boolean {
  return values.some((value) => {
    if (/(?:^|[\s"'=])~[^\s\\/"']+[\\/]/.test(value)) return true;
    const expressions = [
      ...value.matchAll(/%([^%]+)%/g),
      ...value.matchAll(/\$\{([^}]+)\}/g),
      ...value.matchAll(/\$env:([A-Za-z_][A-Za-z0-9_]*)/gi),
      ...value.matchAll(/\$(?!env:)([A-Za-z_][A-Za-z0-9_]*)/gi),
    ];
    return expressions.some((match) => !environmentValue(match[1]));
  });
}

function osHome(): string {
  return process.env.USERPROFILE || process.env.HOME || '';
}

function realPathThroughExistingAncestor(candidate: string): string {
  const resolved = path.resolve(candidate);
  let ancestor = resolved;
  const missing: string[] = [];

  while (!fs.existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) return path.normalize(resolved);
    missing.unshift(path.basename(ancestor));
    ancestor = parent;
  }

  try {
    return path.resolve(fs.realpathSync.native(ancestor), ...missing);
  } catch {
    return path.normalize(resolved);
  }
}

function resolveScopedPath(candidate: string, base: string): string {
  const expanded = expandPathVariables(candidate);
  const absolute = path.isAbsolute(expanded) || path.win32.isAbsolute(expanded)
    ? expanded
    : path.resolve(base, expanded);
  return path.normalize(realPathThroughExistingAncestor(absolute));
}

function extractEffectiveCwd(command: string, projectRoot: string, input: Record<string, unknown>): string {
  const explicitCwd = typeof input.cwd === 'string' ? input.cwd : null;
  if (explicitCwd) return resolveScopedPath(explicitCwd, projectRoot);

  const cdMatch = command.match(
    /(?:^|[;&|]\s*)(?:(?:cd|chdir|pushd)\s+(?:\/d\s+)?|set-location\s+)(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/i,
  );
  const target = cdMatch?.[1] ?? cdMatch?.[2] ?? cdMatch?.[3];
  return target ? resolveScopedPath(target, projectRoot) : projectRoot;
}

function commandBodyWithoutLeadingCwd(command: string): string {
  return command
    .replace(
      /^\s*(?:(?:cd|chdir|pushd)\s+(?:\/d\s+)?|set-location\s+)(?:"[^"]+"|'[^']+'|[^\s;&|]+)\s*(?:&&|;|\|)\s*/i,
      '',
    )
    .trim();
}

function hasUnquotedOrdinaryBackslashEscape(command: string): boolean {
  let quote: "'" | '"' | null = null;

  for (let index = 0; index < command.length - 1; index += 1) {
    const character = command[index];
    if (character === "'" && quote !== '"') {
      quote = quote === "'" ? null : "'";
      continue;
    }
    if (character === '"' && quote !== "'") {
      quote = quote === '"' ? null : '"';
      continue;
    }
    if (quote === null && character === '\\' && /[A-Za-z0-9_]/.test(command[index + 1])) {
      return true;
    }
  }

  return false;
}

function hasMixedQuotedShellWord(command: string): boolean {
  let quote: "'" | '"' | null = null;
  let hasQuotedSegment = false;
  let hasUnquotedContent = false;

  const closesMixedWord = (): boolean => {
    const mixed = hasQuotedSegment && hasUnquotedContent;
    hasQuotedSegment = false;
    hasUnquotedContent = false;
    return mixed;
  };

  for (const character of command) {
    if (quote !== null) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      hasQuotedSegment = true;
      continue;
    }
    if (/\s|[;&|<>]/.test(character)) {
      if (closesMixedWord()) return true;
      continue;
    }
    hasUnquotedContent = true;
  }

  return hasQuotedSegment && hasUnquotedContent;
}

function classifyShellCapability(command: string, shellTool: string): {
  capability: PermissionCapability;
  risk: PermissionRisk;
  commandPattern: string | null;
  nonReusableReason?: string;
} {
  const body = commandBodyWithoutLeadingCwd(command);

  if (
    (shellTool === 'bash' || shellTool === 'shell')
    && hasUnquotedOrdinaryBackslashEscape(command)
  ) {
    return {
      capability: 'shell.unknown',
      risk: 'high',
      commandPattern: null,
      nonReusableReason: 'Ambiguous shell escape syntax requires one-time confirmation.',
    };
  }

  if (DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(body))) {
    return {
      capability: 'shell.destructive',
      risk: 'high',
      commandPattern: null,
      nonReusableReason: '破坏性、发布或不可逆命令必须逐次确认。',
    };
  }
  if (CREDENTIAL_PATTERNS.some((pattern) => pattern.test(body))) {
    return {
      capability: 'shell.read_only',
      risk: 'high',
      commandPattern: null,
      nonReusableReason: '凭证或敏感配置访问必须逐次确认。',
    };
  }
  if (ELEVATION_PATTERNS.some((pattern) => pattern.test(body))) {
    return {
      capability: 'shell.process_control',
      risk: 'high',
      commandPattern: null,
      nonReusableReason: '提权或编码脚本必须逐次确认。',
    };
  }

  if (UNSAFE_NESTED_SHELL_PATTERNS.some((pattern) => pattern.test(body))) {
    return {
      capability: 'shell.unknown',
      risk: 'high',
      commandPattern: null,
      nonReusableReason: '嵌套解释器、命令替换或多行 shell 语法必须逐次确认。',
    };
  }

  if (
    hasMixedQuotedShellWord(command)
    || AMBIGUOUS_SHELL_PATH_PATTERNS.some((pattern) => pattern.test(command))
  ) {
    return {
      capability: 'shell.unknown',
      risk: 'high',
      commandPattern: null,
      nonReusableReason: 'Ambiguous shell path syntax requires one-time confirmation.',
    };
  }

  const networkCommand = /^\s*(?:curl|wget|invoke-webrequest|iwr)(?=\s|$)/i.test(body);
  const networkFileIo = networkCommand && (
    /^\s*wget(?=\s|$)/i.test(body)
    || /(?:^|\s)(?:-o|--output|-O|--remote-name|-T|--upload-file|-K|--config|--netrc-file|--cert|--key|--cookie|-OutFile|-InFile)(?=\s|=|$)/i.test(body)
    || /(?:^|\s)-(?!-)\S*[oOTKbc]\S*/.test(body)
    || /(?:^|\s)-(?:d|F)\S*@/i.test(body)
    || /(?:^|\s)(?:-F|--form|-d|--data|--data-binary|--data-raw|--data-urlencode)(?=\s|=)[^;&|]*@/i.test(body)
    || /(?:^|[^>])>{1,2}(?![>&])/.test(body)
  );
  if (networkFileIo) {
    return {
      capability: 'shell.unknown',
      risk: 'high',
      commandPattern: null,
      nonReusableReason: 'Combined network and local file I/O requires one-time confirmation.',
    };
  }

  const readCommand = /^\s*(?:ls|dir|pwd|echo|type|cat|get-content|head|tail|find|where|which)(?=\s|$)/i.test(body);
  const ambiguousReadExpansion = readCommand && (
    /[*?\[\]{}]/.test(body)
    || /(?:^|[\\/\s])\.[A-Za-z][^\s;&|]*['"$]/.test(body)
    || /(?:^|[\\/\s])\.[A-Za-z][^\\\s;&|]*\\[A-Za-z]/.test(body)
  );
  if (ambiguousReadExpansion) {
    return {
      capability: 'shell.unknown',
      risk: 'high',
      commandPattern: null,
      nonReusableReason: 'Ambiguous shell-expanded read targets require one-time confirmation.',
    };
  }

  const commandSegments = body
    .split(/\s*(?:&&|\|\||[;|])\s*/)
    .map((segment) => segment.trim())
    .filter(Boolean);
  if (commandSegments.length > 1) {
    const capabilityPriority: Partial<Record<PermissionCapability, number>> = {
      'shell.unknown': 100,
      'shell.destructive': 100,
      'shell.process_control': 95,
      'shell.package_install': 90,
      'shell.git_mutation': 85,
      'shell.file_write': 80,
      'shell.file_copy': 75,
      'shell.network': 70,
      'shell.build': 60,
      'shell.test': 55,
      'shell.run_project': 50,
      'shell.git_read': 40,
      'shell.read_only': 30,
    };
    const classified = commandSegments
      .map((segment) => classifyShellCapability(segment, shellTool))
      .sort((left, right) => (
        RISK_RANK[right.risk] - RISK_RANK[left.risk]
        || (capabilityPriority[right.capability] ?? 0)
          - (capabilityPriority[left.capability] ?? 0)
      ));
    if (
      new Set(classified.map((item) => item.capability)).size > 1
      || new Set(classified.map((item) => item.commandPattern)).size > 1
    ) {
      return {
        capability: 'shell.unknown',
        risk: 'high',
        commandPattern: null,
        nonReusableReason: '混合多种能力的复合 shell 命令必须逐次确认。',
      };
    }
    return classified[0];
  }

  const outputRedirectionProbe = body.replace(/\d*>&\d+/g, '');
  if (/(?:^|[^>])>(?!>)/.test(outputRedirectionProbe)) {
    return {
      capability: 'shell.file_write',
      risk: 'high',
      commandPattern: null,
      nonReusableReason: 'Overwrite redirection requires one-time confirmation.',
    };
  }
  if (/>>/.test(outputRedirectionProbe)) {
    return { capability: 'shell.file_write', risk: 'medium', commandPattern: null };
  }

  if (/^\s*(?:npm|pnpm|yarn|bun)\s+(?:install|i|add|update|upgrade|remove|uninstall)(?=\s|$)/i.test(body)
    || /^\s*(?:pip|pip3)\s+install(?=\s|$)/i.test(body)
    || /^\s*(?:cargo\s+(?:add|install|update)|dotnet\s+add\s+package)(?=\s|$)/i.test(body)) {
    return { capability: 'shell.package_install', risk: 'medium', commandPattern: null };
  }

  if (/^\s*git\s+(?:status|diff|log|show|rev-parse|ls-files)(?=\s|$)[^\r\n]*(?:\s--output(?:=|\s)|\s-o(?=\s|$))/i.test(body)) {
    return {
      capability: 'shell.file_write',
      risk: 'high',
      commandPattern: null,
      nonReusableReason: 'Git query output writes require one-time confirmation.',
    };
  }

  const gitBranch = body.match(/^\s*git\s+branch(?=\s|$)(.*)$/i);
  if (gitBranch) {
    const args = gitBranch[1].trim();
    const mutationFlag = /(?:^|\s)(?:-[A-Za-z]*[dDmMcCfFuUtT][A-Za-z]*|--(?:delete|move|copy|edit-description|set-upstream-to|unset-upstream|create-reflog|force|track))(?=\s|=|$)/.test(args);
    const safeQuery = !mutationFlag && (
      args.length === 0
      || /^(?:--list|--show-current|-a|--all|-r|--remotes|-v|-vv|--contains|--no-contains|--merged|--no-merged|--points-at|--format|--sort|--column)(?=\s|=|$)/i.test(args)
    );
    if (safeQuery) {
      return { capability: 'shell.git_read', risk: 'low', commandPattern: null };
    }
    return {
      capability: 'shell.git_mutation',
      risk: 'high',
      commandPattern: 'git:branch',
      nonReusableReason: 'Git branch creation or mutation requires one-time confirmation.',
    };
  }

  if (/^\s*git\s+(?:status|diff|log|show|rev-parse|ls-files)(?=\s|$)/i.test(body)
    || /^\s*git\s+remote\s+-v(?=\s|$)/i.test(body)) {
    return { capability: 'shell.git_read', risk: 'low', commandPattern: null };
  }
  const gitMutation = body.match(/^\s*git\s+(add|commit|checkout|switch|merge|rebase|cherry-pick|tag|stash|reset|clean|push|pull|fetch)(?=\s|$)/i);
  if (gitMutation) {
    return {
      capability: 'shell.git_mutation',
      risk: 'medium',
      commandPattern: `git:${gitMutation[1].toLocaleLowerCase('en-US')}`,
    };
  }

  if (/^\s*(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test(?=\s|$)/i.test(body)
    || /^\s*npx\s+(?:(?:vitest|jest|mocha|ava)(?=\s|$)|playwright\s+test(?=\s|$))/i.test(body)
    || /^\s*(?:pytest|python\s+-m\s+pytest|cargo\s+test|go\s+test|dotnet\s+test|mvn\s+test|gradle\s+test)(?=\s|$)/i.test(body)) {
    return { capability: 'shell.test', risk: 'medium', commandPattern: null };
  }

  if (/^\s*(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:build|package|dist)(?=\s|$)/i.test(body)
    || /^\s*(?:npx\s+)?electron-builder(?=\s|$)/i.test(body)
    || /^\s*(?:cargo\s+build|go\s+build|dotnet\s+build|mvn\s+package|gradle\s+build|tsc)(?=\s|$)/i.test(body)) {
    return { capability: 'shell.build', risk: 'medium', commandPattern: null };
  }

  if (/^\s*(?:curl|wget|invoke-webrequest|iwr)(?=\s|$)/i.test(body)) {
    return { capability: 'shell.network', risk: 'medium', commandPattern: null };
  }
  if (/^\s*(?:cp|copy|xcopy|robocopy)(?=\s|$)/i.test(body)) {
    return { capability: 'shell.file_copy', risk: 'medium', commandPattern: null };
  }
  if (/^\s*(?:touch|mkdir|md|move|mv|set-content|add-content|out-file)(?=\s|$)/i.test(body)
  ) {
    return { capability: 'shell.file_write', risk: 'medium', commandPattern: null };
  }
  if (/^\s*(?:node|tsx|ts-node|python|python3|cargo\s+run|go\s+run|npm\s+(?:run\s+)?(?:dev|start)|pnpm\s+(?:run\s+)?(?:dev|start)|yarn\s+(?:run\s+)?(?:dev|start))(?=\s|$)/i.test(body)) {
    return { capability: 'shell.run_project', risk: 'medium', commandPattern: null };
  }
  if (/^\s*(?:ls|dir|pwd|echo|type|cat|get-content|head|tail|find|where|which)(?=\s|$)/i.test(body)) {
    return { capability: 'shell.read_only', risk: 'low', commandPattern: null };
  }

  return {
    capability: 'shell.unknown',
    risk: 'high',
    commandPattern: null,
    nonReusableReason: '未分类的 shell 命令按高风险逐次确认。',
  };
}

function globSearchRoot(pattern: string, effectiveCwd: string): string {
  const expanded = expandPathVariables(pattern);
  const firstMeta = expanded.search(/[*?\[{]/);
  const staticPrefix = firstMeta < 0 ? expanded : expanded.slice(0, firstMeta);
  const candidate = staticPrefix.replace(/[\\/]+$/u, '') || '.';
  return resolveScopedPath(candidate, effectiveCwd);
}

function hasUnscopedGlobAlternative(
  normalizedTool: string,
  input: Record<string, unknown>,
): boolean {
  if (normalizedTool !== 'glob' || typeof input.pattern !== 'string') return false;
  const expanded = expandPathVariables(input.pattern);
  const firstMeta = expanded.search(/[*?\[{]/);
  if (firstMeta < 0) return false;
  const dynamicSuffix = expanded.slice(firstMeta);
  return /(?:^|[\\/])\.\.(?:[\\/]|$)/u.test(dynamicSuffix)
    || /[A-Za-z]:[\\/]/u.test(dynamicSuffix)
    || /(?:^|[,{}])~[^\\/\s]+[\\/]/u.test(dynamicSuffix);
}

function targetPathsFromInput(
  input: Record<string, unknown>,
  effectiveCwd: string,
  normalizedTool: string,
): string[] {
  const targets = new Set<string>();
  for (const key of ['file_path', 'path', 'target_path', 'destination', 'source', 'notebook_path']) {
    const value = input[key];
    if (typeof value !== 'string' || value.trim().length === 0) continue;
    try {
      targets.add(resolveScopedPath(value, effectiveCwd));
    } catch {
      // Failed path parsing is represented by the conservative tool risk.
    }
  }
  if (normalizedTool === 'glob' && typeof input.pattern === 'string' && input.pattern.trim()) {
    try {
      targets.add(globSearchRoot(input.pattern, effectiveCwd));
    } catch {
      // Ambiguous glob roots are rejected by the post-classification guard.
    }
  }
  return [...targets];
}

function targetPathsFromShell(command: string, effectiveCwd: string): string[] {
  const targets = new Set<string>();
  const addTarget = (candidate: string): void => {
    let token = candidate.trim();
    const assignmentIndex = token.indexOf('=');
    if (assignmentIndex > 0 && /^[\w.-]+$/.test(token.slice(0, assignmentIndex))) {
      token = token.slice(assignmentIndex + 1);
    }
    token = token.replace(/^@/, '');
    if (
      !token
      || /^https?:\/\//i.test(token)
      || /^\d+$/.test(token)
    ) return;
    const pathLike = path.isAbsolute(token)
      || path.win32.isAbsolute(token)
      || /^(?:~|\.{1,2})(?:[\\/]|$)/.test(token)
      || token.includes('\\')
      || token.includes('/')
      || SENSITIVE_BARE_PATH_PATTERN.test(token);
    if (!pathLike) return;
    try {
      targets.add(resolveScopedPath(token, effectiveCwd));
    } catch {
      // Ambiguous path-like arguments are left to the conservative command
      // classifier; unknown commands are already high-risk and non-reusable.
    }
  };

  const assignedOptionPattern = /(?:^|\s)-{1,2}[\w-]+=(?:"([^"]+)"|'([^']+)'|([^\s;&|<>]+))/g;
  for (const match of command.matchAll(assignedOptionPattern)) {
    addTarget(match[1] ?? match[2] ?? match[3] ?? '');
  }

  const atFilePattern = /@(?:"([^"]+)"|'([^']+)'|([^\s;&|<>]+))/g;
  for (const match of command.matchAll(atFilePattern)) {
    addTarget(match[1] ?? match[2] ?? match[3] ?? '');
  }

  const tokenPattern = /"([^"]*)"|'([^']*)'|([^\s;&|<>]+)/g;
  for (const match of command.matchAll(tokenPattern)) {
    let token = (match[1] ?? match[2] ?? match[3] ?? '').trim();
    if (
      !token
      || /^https?:\/\//i.test(token)
      || /^\d+$/.test(token)
    ) continue;
    if (token.startsWith('-')) {
      if (token.includes('=')) continue;
      const attachedPathIndex = [
        token.search(/[A-Za-z]:[\\/]/),
        token.indexOf('/'),
        token.search(/\.{1,2}[\\/]/),
        token.search(/~[\\/]/),
      ].filter((index) => index > 0).sort((left, right) => left - right)[0];
      if (attachedPathIndex === undefined) continue;
      token = token.slice(attachedPathIndex);
    }
    addTarget(token);
  }
  return [...targets];
}

function stableToolName(toolName: string): string {
  return toolName.trim().toLocaleLowerCase('en-US');
}

function pathLikeInputValues(input: Record<string, unknown>): string[] {
  const values: string[] = [];
  for (const key of [
    'file_path',
    'path',
    'target_path',
    'destination',
    'source',
    'cwd',
    'notebook_path',
    'pattern',
    'glob',
    'include',
  ]) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) values.push(value.trim());
  }
  return values;
}

function sensitivePath(values: readonly string[]): boolean {
  return values.some((value) => (
    GIT_METADATA_PATTERN.test(value)
    || SENSITIVE_DIRECTORY_PATTERN.test(value)
    || CREDENTIAL_PATTERNS.some((pattern) => pattern.test(value))
  ));
}

function systemRoots(): string[] {
  if (process.platform === 'win32') {
    return [
      process.env.WINDIR,
      process.env.SystemRoot,
      process.env.ProgramFiles,
      process.env['ProgramFiles(x86)'],
      process.env.ProgramData,
      'C:\\Windows',
    ]
      .filter((value): value is string => Boolean(value?.trim()))
      .map((value) => realPathThroughExistingAncestor(value));
  }
  return ['/etc', '/usr', '/bin', '/sbin', '/var', '/System', '/Library'];
}

function targetsSystemLocation(values: readonly string[]): boolean {
  const roots = systemRoots();
  return values.some((value) => roots.some((root) => isContainedBy(root, value)));
}

function outsideScopeTargets(analysis: PermissionAnalysis): string[] {
  const targets = analysis.targetPaths.filter((target) => (
    !isContainedBy(analysis.canonicalProjectPath, target)
  ));
  if (!isContainedBy(analysis.canonicalProjectPath, analysis.effectiveCwd)) {
    targets.push(analysis.effectiveCwd);
  }
  return [...new Set(targets)];
}

export function analyzePermissionRequest(
  toolName: string,
  input: Record<string, unknown>,
  projectPath: string,
): PermissionAnalysis {
  const project = canonicalizeProjectPath(projectPath);
  const normalizedTool = stableToolName(toolName);
  const command = typeof input.command === 'string'
    ? input.command
    : typeof input.cmd === 'string'
      ? input.cmd
      : typeof input.script === 'string'
        ? input.script
        : '';

  let capability: PermissionCapability;
  let risk: PermissionRisk;
  let commandPattern: string | null = null;
  let nonReusableReason: string | undefined;

  if (normalizedTool === 'bypasspermissions') {
    capability = 'shell.unknown';
    risk = 'high';
    nonReusableReason = 'bypassPermissions 只能通过独立高风险流程逐次授权。';
  } else if (SHELL_TOOLS.has(normalizedTool)) {
    const shell = classifyShellCapability(command, normalizedTool);
    ({ capability, risk, commandPattern, nonReusableReason } = shell);
  } else if (READ_TOOLS.has(normalizedTool)) {
    capability = 'tool.read';
    risk = 'low';
  } else if (WRITE_TOOLS.has(normalizedTool)) {
    capability = 'tool.write';
    risk = 'medium';
  } else if (NETWORK_TOOLS.has(normalizedTool)) {
    capability = 'tool.network';
    risk = 'medium';
  } else {
    capability = 'tool.unknown';
    risk = 'high';
    nonReusableReason = '未分类工具按高风险逐次确认。';
  }

  const effectiveCwd = SHELL_TOOLS.has(normalizedTool)
    ? extractEffectiveCwd(command, project.displayPath, input)
    : project.displayPath;
  const targetPaths = [...new Set([
    ...targetPathsFromInput(input, effectiveCwd, normalizedTool),
    ...(SHELL_TOOLS.has(normalizedTool) ? targetPathsFromShell(command, effectiveCwd) : []),
  ])];
  const outsideProject = !isContainedBy(project.displayPath, effectiveCwd)
    || targetPaths.some((target) => !isContainedBy(project.displayPath, target));
  const externalRoot = outsideProject
    ? (!isContainedBy(project.displayPath, effectiveCwd)
      ? effectiveCwd
      : targetPaths.find((target) => !isContainedBy(project.displayPath, target)) ?? null)
    : null;
  const originalPathExpressions = [command, ...pathLikeInputValues(input)];
  const sensitiveInputs = [...originalPathExpressions, ...targetPaths, effectiveCwd];
  if (
    hasUnresolvedPathExpression(originalPathExpressions)
    || hasUnscopedGlobAlternative(normalizedTool, input)
  ) {
    risk = 'high';
    nonReusableReason = 'Unresolved environment or user-home path expressions cannot be reused safely.';
  } else if (
    sensitivePath(sensitiveInputs)
    || SENSITIVE_DIRECTORY_PATTERN.test(effectiveCwd)
  ) {
    risk = 'high';
    nonReusableReason = '凭证、敏感配置或 Git 元数据访问必须逐次确认。';
  } else if (
    WRITE_EFFECT_CAPABILITIES.has(capability)
    && targetsSystemLocation([...targetPaths, effectiveCwd])
  ) {
    risk = 'high';
    nonReusableReason = '系统目录写入或执行必须逐次确认。';
  }
  const cacheableForTask = risk !== 'high'
    && TASK_CACHEABLE_CAPABILITIES.has(capability)
    && !outsideProject;
  const persistableForProject = cacheableForTask
    && SAFE_PROJECT_CAPABILITIES.has(capability)
    && !outsideProject;
  const normalizedRule = [
    `tool=${normalizedTool}`,
    `capability=${capability}`,
    `project=${project.canonicalPath}`,
    `risk=${risk}`,
    ...(commandPattern ? [`pattern=${commandPattern}`] : []),
    ...(externalRoot ? [`external=${canonicalCase(externalRoot)}`] : []),
  ].join(';');

  return {
    toolName,
    capability,
    risk,
    canonicalProjectPath: project.canonicalPath,
    effectiveCwd,
    targetPaths,
    externalRoot,
    outsideProject,
    cacheableForTask,
    persistableForProject,
    normalizedRule,
    commandPattern,
    ...(nonReusableReason ? { nonReusableReason } : {}),
  };
}

export function canPersistProjectRule(analysis: PermissionAnalysis): boolean {
  return analysis.persistableForProject
    && analysis.risk !== 'high'
    && analysis.externalRoot === null
    && analysis.capability !== 'shell.destructive'
    && analysis.capability !== 'shell.unknown';
}

export function createPermissionRule(
  analysis: PermissionAnalysis,
  scope: PermissionRuleScope,
  options: { id?: string; externalRoot?: string; now?: number } = {},
): PermissionRule {
  const scopedExternalRoot = options.externalRoot
    ? canonicalCase(realPathThroughExistingAncestor(options.externalRoot))
    : null;
  const externalTaskGrant = scope === 'task'
    && analysis.outsideProject
    && Boolean(scopedExternalRoot)
    && analysis.risk !== 'high'
    && TASK_CACHEABLE_CAPABILITIES.has(analysis.capability);

  if (scope === 'project' && !canPersistProjectRule(analysis)) {
    throw new Error('This permission request cannot be persisted as a project rule.');
  }
  if (!analysis.cacheableForTask && !externalTaskGrant) {
    throw new Error('This permission request cannot be reused.');
  }
  if (
    externalTaskGrant
    && outsideScopeTargets(analysis).some((target) => !isContainedBy(scopedExternalRoot!, target))
  ) {
    throw new Error('The external root does not contain every requested target.');
  }

  return {
    id: options.id ?? crypto.randomUUID(),
    scope,
    toolName: stableToolName(analysis.toolName),
    capability: analysis.capability,
    canonicalProjectPath: analysis.canonicalProjectPath,
    riskCeiling: analysis.risk,
    commandPattern: analysis.commandPattern,
    externalRoot: scopedExternalRoot,
    createdAt: options.now ?? Date.now(),
    enabled: true,
  };
}

export function permissionRuleMatches(
  rule: PermissionRule,
  analysis: PermissionAnalysis,
): boolean {
  if (!rule.enabled) return false;
  if (rule.toolName !== stableToolName(analysis.toolName)) return false;
  if (rule.capability !== analysis.capability) return false;
  if (canonicalCase(rule.canonicalProjectPath) !== canonicalCase(analysis.canonicalProjectPath)) return false;
  if (RISK_RANK[analysis.risk] > RISK_RANK[rule.riskCeiling]) return false;
  if (analysis.risk === 'high') return false;

  if (analysis.outsideProject) {
    if (rule.scope !== 'task' || !rule.externalRoot || !analysis.externalRoot) return false;
    if (outsideScopeTargets(analysis).some((target) => !isContainedBy(rule.externalRoot!, target))) {
      return false;
    }
  } else if (rule.externalRoot) {
    return false;
  }

  if (rule.scope === 'project' && !canPersistProjectRule(analysis)) return false;
  if (rule.commandPattern && rule.commandPattern !== analysis.commandPattern) return false;
  return true;
}

export function permissionRuleCacheKey(rule: PermissionRule): string {
  return crypto.createHash('sha256').update(JSON.stringify({
    scope: rule.scope,
    toolName: rule.toolName,
    capability: rule.capability,
    project: canonicalCase(rule.canonicalProjectPath),
    riskCeiling: rule.riskCeiling,
    commandPattern: rule.commandPattern,
    externalRoot: rule.externalRoot ? canonicalCase(rule.externalRoot) : null,
  })).digest('hex');
}

export const permissionRuleEngineInternals = {
  canonicalCase,
  isContainedBy,
  realPathThroughExistingAncestor,
};
