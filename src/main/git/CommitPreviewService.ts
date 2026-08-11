import path from 'path';
import type {
  CommitPreview,
  CommitPreviewInput,
  CommitPreviewTimelineItem,
  ConventionalCommitType,
  GitStatusFile,
} from '../../shared/types/git';

const COMMIT_TYPES: readonly ConventionalCommitType[] = [
  'feat',
  'fix',
  'docs',
  'style',
  'refactor',
  'perf',
  'test',
  'build',
  'ci',
  'chore',
  'revert',
];

const TYPE_RULES: ReadonlyArray<readonly [ConventionalCommitType, RegExp]> = [
  ['revert', /\b(?:revert|rollback|restore)\b|回滚|撤销|恢复/iu],
  ['fix', /\b(?:fix|bug|repair|error|crash|regression|broken)\b|修复|纠正|故障|错误/iu],
  ['perf', /\b(?:perf|performance|optimi[sz]e|latency|faster)\b|性能|优化|提速/iu],
  ['refactor', /\b(?:refactor|restructure|rewrite|simplify)\b|重构|改写|整理代码/iu],
  ['docs', /\b(?:docs?|documentation|readme|changelog)\b|文档|说明/iu],
  ['test', /\b(?:tests?|spec|coverage)\b|测试|覆盖率/iu],
  ['ci', /\b(?:ci|workflow|pipeline|github actions?)\b|持续集成/iu],
  ['build', /\b(?:build|bundle|dependency|dependencies|package|compile)\b|构建|依赖|打包/iu],
  ['style', /\b(?:format|formatting|lint|whitespace)\b|格式化|代码风格/iu],
  ['chore', /\b(?:chore|maintenance|cleanup|housekeeping)\b|维护|清理/iu],
  ['feat', /\b(?:add|create|implement|introduce|support|feature|enable)\b|新增|添加|实现|支持|功能/iu],
];

const GENERIC_SCOPE_SEGMENTS = new Set([
  'src',
  'source',
  'app',
  'apps',
  'main',
  'renderer',
  'shared',
  'common',
  'features',
  'feature',
  'components',
  'component',
  'pages',
  'lib',
  'libs',
  'server',
  'client',
  'test',
  'tests',
  '__tests__',
  'spec',
  'specs',
]);

const GENERIC_FILE_SCOPES = new Set([
  'index',
  'types',
  'type',
  'utils',
  'util',
  'helpers',
  'helper',
  'constants',
  'service',
  'component',
]);

function timelineText(item: CommitPreviewTimelineItem): string {
  if (typeof item === 'string') return item;
  return [item.title, item.detail, item.eventType].filter(Boolean).join(' ');
}

function explicitConventionalPrefix(title: string): {
  type: ConventionalCommitType;
  scope: string | null;
  remainder: string;
} | null {
  const match = /^\s*([a-z]+)(?:\(([^)]+)\))?!?\s*:\s*(.*)$/iu.exec(title);
  if (!match || !COMMIT_TYPES.includes(match[1].toLowerCase() as ConventionalCommitType)) return null;
  return {
    type: match[1].toLowerCase() as ConventionalCommitType,
    scope: sanitizeScope(match[2] ?? ''),
    remainder: match[3],
  };
}

function inferType(title: string, timeline: readonly CommitPreviewTimelineItem[], files: readonly GitStatusFile[]) {
  const explicit = explicitConventionalPrefix(title);
  if (explicit) return explicit.type;

  for (const [type, pattern] of TYPE_RULES) {
    if (pattern.test(title)) return type;
  }

  const paths = files.map((file) => file.filePath.toLowerCase());
  if (paths.length > 0 && paths.every((file) => /(?:^|\/)(?:docs?|readme|changelog)(?:[/.]|$)/u.test(file))) {
    return 'docs';
  }
  if (paths.length > 0 && paths.every((file) => /(?:^|\/)(?:__tests__|tests?|specs?)(?:\/|$)|\.(?:test|spec)\.[^.]+$/u.test(file))) {
    return 'test';
  }
  if (paths.length > 0 && paths.every((file) => /(?:^|\/)\.github\/workflows\/|(?:^|\/)\.gitlab-ci\./u.test(file))) {
    return 'ci';
  }
  if (paths.length > 0 && paths.every((file) => /(?:^|\/)(?:package(?:-lock)?\.json|pnpm-lock\.yaml|yarn\.lock)$/u.test(file))) {
    return 'build';
  }
  if (files.some((file) => file.changeType === 'added' || file.changeType === 'untracked')) return 'feat';

  const fallbackText = timeline.map(timelineText).join(' ');
  for (const [type, pattern] of TYPE_RULES) {
    if (pattern.test(fallbackText)) return type;
  }
  return 'chore';
}

function sanitizeScope(value: string): string | null {
  const scope = value
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/gu, '-')
    .replace(/-{2,}/gu, '-')
    .replace(/^-|-$/gu, '')
    .slice(0, 24)
    .replace(/-$/u, '');
  return scope || null;
}

function scopeCandidate(filePath: string): string | null {
  const normalized = filePath.replace(/\\/gu, '/').replace(/^\.\//u, '');
  const lower = normalized.toLowerCase();
  if (/^(?:package(?:-lock)?\.json|pnpm-lock\.yaml|yarn\.lock)$/u.test(lower)) return 'deps';
  if (/^(?:readme|changelog|license)(?:\.|$)/u.test(lower) || lower.startsWith('docs/')) return 'docs';
  if (lower.startsWith('.github/workflows/') || lower.startsWith('.gitlab-ci.')) return 'ci';

  const segments = normalized.split('/').filter(Boolean);
  const directorySegments = segments.slice(0, -1);
  for (let index = directorySegments.length - 1; index >= 0; index -= 1) {
    const candidate = sanitizeScope(directorySegments[index]);
    if (candidate && !GENERIC_SCOPE_SEGMENTS.has(candidate)) return candidate;
  }

  const basename = path.posix.basename(normalized).replace(/\.(?:test|spec)(?=\.)/u, '').split('.')[0];
  const candidate = sanitizeScope(basename);
  return candidate && !GENERIC_FILE_SCOPES.has(candidate) ? candidate : null;
}

function inferScope(title: string, files: readonly GitStatusFile[]): string | null {
  const explicit = explicitConventionalPrefix(title);
  if (explicit?.scope) return explicit.scope;

  const counts = new Map<string, number>();
  for (const file of files) {
    const candidate = scopeCandidate(file.filePath);
    if (candidate) counts.set(candidate, (counts.get(candidate) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0))[0]?.[0]
    ?? null;
}

function cleanDescription(value: string): string {
  let description = value
    .replace(/^\s*(?:task|任务)\s*[-#:：]\s*/iu, '')
    .replace(/[`*_#]+/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/[.!?。！？:：;,，；]+$/gu, '');
  if (/^[A-Z]/u.test(description)) {
    description = `${description[0].toLowerCase()}${description.slice(1)}`;
  }
  return description;
}

function fallbackDescription(
  timeline: readonly CommitPreviewTimelineItem[],
  files: readonly GitStatusFile[],
  scope: string | null,
): string {
  for (const item of timeline) {
    const candidate = cleanDescription(timelineText(item));
    if (candidate) return candidate;
  }
  if (files.length === 1) {
    const basename = path.posix.basename(files[0].filePath.replace(/\\/gu, '/'));
    return `update ${basename}`;
  }
  return scope ? `update ${scope} workflow` : 'update project files';
}

function safeCount(value: number): number {
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

/** Generates a conventional-commit preview from local task data without calling a model. */
export class CommitPreviewService {
  createPreview(input: CommitPreviewInput): CommitPreview {
    const timeline = input.timeline ?? [];
    const files = [...input.files].sort((left, right) => (
      left.filePath < right.filePath ? -1 : left.filePath > right.filePath ? 1 : 0
    ));
    const explicit = explicitConventionalPrefix(input.taskTitle);
    const type = inferType(input.taskTitle, timeline, files);
    const scope = inferScope(input.taskTitle, files);
    const rawDescription = cleanDescription(explicit?.remainder ?? input.taskTitle)
      || fallbackDescription(timeline, files, scope);
    const prefix = scope ? `${type}(${scope}): ` : `${type}: `;
    const maxDescriptionLength = Math.max(1, 72 - prefix.length);
    const description = rawDescription
      .slice(0, maxDescriptionLength)
      .trimEnd()
      .replace(/[.!?。！？:：;,，；-]+$/gu, '')
      || 'update project files';
    const subject = `${prefix}${description}`;
    const uniqueFiles = [...new Set(files.map((file) => file.filePath))];

    return {
      type,
      scope,
      description,
      subject,
      message: subject,
      files: uniqueFiles,
      fileCount: uniqueFiles.length,
      additions: files.reduce((sum, file) => sum + safeCount(file.additions), 0),
      deletions: files.reduce((sum, file) => sum + safeCount(file.deletions), 0),
    };
  }

  /** Compatibility alias for callers that name the operation after its output. */
  create(input: CommitPreviewInput): CommitPreview {
    return this.createPreview(input);
  }

  createCommitPreview(input: CommitPreviewInput): CommitPreview {
    return this.createPreview(input);
  }
}
