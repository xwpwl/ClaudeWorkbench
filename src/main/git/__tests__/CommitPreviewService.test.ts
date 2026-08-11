import { describe, expect, it } from 'vitest';
import type { GitStatusFile } from '../../../shared/types/git';
import { CommitPreviewService } from '../CommitPreviewService';

const service = new CommitPreviewService();

function file(filePath: string, overrides: Partial<GitStatusFile> = {}): GitStatusFile {
  return {
    filePath,
    changeType: 'modified',
    statusCode: ' M',
    staged: false,
    unstaged: true,
    untracked: false,
    additions: 3,
    deletions: 1,
    statsAvailable: true,
    isBinary: false,
    ...overrides,
  };
}

describe('CommitPreviewService conventional type inference', () => {
  it.each([
    ['feat(auth): add passkeys', 'feat', 'auth', 'add passkeys'],
    ['fix(api): repair retries', 'fix', 'api', 'repair retries'],
    ['docs(readme): explain setup', 'docs', 'readme', 'explain setup'],
    ['style(ui): format cards', 'style', 'ui', 'format cards'],
    ['refactor(core): simplify state', 'refactor', 'core', 'simplify state'],
    ['perf(db): optimize lookup', 'perf', 'db', 'optimize lookup'],
    ['test(cli): cover cancellation', 'test', 'cli', 'cover cancellation'],
    ['build(deps): update vite', 'build', 'deps', 'update vite'],
    ['ci(win): add smoke job', 'ci', 'win', 'add smoke job'],
    ['chore(repo): clean fixtures', 'chore', 'repo', 'clean fixtures'],
    ['revert(auth): restore login', 'revert', 'auth', 'restore login'],
  ] as const)('preserves an explicit %s conventional prefix', (title, type, scope, description) => {
    expect(service.createPreview({ taskTitle: title, files: [file('src/other/file.ts')] }))
      .toMatchObject({ type, scope, description, subject: `${type}(${scope}): ${description}` });
  });

  it.each([
    ['Add account switching', 'feat'],
    ['Fix session crash', 'fix'],
    ['Improve performance of queries', 'perf'],
    ['Refactor workspace state', 'refactor'],
    ['Update README documentation', 'docs'],
    ['Increase parser test coverage', 'test'],
    ['Update CI workflow', 'ci'],
    ['Update package dependencies', 'build'],
    ['Format source whitespace', 'style'],
    ['Routine maintenance cleanup', 'chore'],
    ['Rollback unsafe migration', 'revert'],
    ['新增检查点工作流', 'feat'],
    ['修复权限错误', 'fix'],
  ] as const)('maps task title %j to %s', (taskTitle, type) => {
    expect(service.createPreview({ taskTitle, files: [file('src/core/state.ts')] }).type).toBe(type);
  });

  it('infers docs when every changed path is documentation', () => {
    expect(service.createPreview({ taskTitle: 'Update information', files: [file('README.md'), file('docs/setup.md')] }).type)
      .toBe('docs');
  });

  it('infers test when every changed path is a test', () => {
    expect(service.createPreview({
      taskTitle: 'Update scenarios',
      files: [file('src/__tests__/a.test.ts'), file('tests/e2e.spec.ts')],
    }).type).toBe('test');
  });

  it('infers CI from workflow-only changes', () => {
    expect(service.createPreview({
      taskTitle: 'Update automation',
      files: [file('.github/workflows/test.yml')],
    }).type).toBe('ci');
  });

  it('infers build from dependency manifest-only changes', () => {
    expect(service.createPreview({
      taskTitle: 'Update versions',
      files: [file('package.json'), file('package-lock.json')],
    }).type).toBe('build');
  });

  it('infers feat from an added file when the title has no signal', () => {
    expect(service.createPreview({
      taskTitle: 'Workspace update',
      files: [file('src/new.ts', { changeType: 'added', staged: true })],
    }).type).toBe('feat');
  });

  it('uses timeline text only when stronger title and file signals are absent', () => {
    expect(service.createPreview({
      taskTitle: 'Workspace update',
      timeline: [{ title: '修复失败的重试流程', successful: true }],
      files: [file('src/core/state.ts')],
    }).type).toBe('fix');
  });

  it('defaults an ambiguous modification to chore', () => {
    expect(service.createPreview({ taskTitle: 'Workspace update', files: [file('src/core/state.ts')] }).type)
      .toBe('chore');
  });
});

describe('CommitPreviewService deterministic scope and message', () => {
  it.each([
    [['src/main/git/GitWorkspaceService.ts'], 'git'],
    [['src/features/auth/login.ts'], 'auth'],
    [['src/renderer/checkpoints/Panel.tsx'], 'checkpoints'],
    [['docs/setup.md'], 'docs'],
    [['README.md'], 'docs'],
    [['package-lock.json'], 'deps'],
    [['.github/workflows/test.yml'], 'ci'],
    [['src/api.ts'], 'api'],
  ] as const)('derives scope from %j', (paths, scope) => {
    expect(service.createPreview({
      taskTitle: 'Update workspace',
      files: paths.map((item) => file(item)),
    }).scope).toBe(scope);
  });

  it('uses the most common scope and a lexical tie-breaker', () => {
    const preview = service.createPreview({
      taskTitle: 'Update modules',
      files: [
        file('src/zeta/a.ts'),
        file('src/auth/a.ts'),
        file('src/auth/b.ts'),
        file('src/zeta/b.ts'),
      ],
    });
    expect(preview.scope).toBe('auth');
  });

  it('sanitizes an explicit scope', () => {
    expect(service.createPreview({
      taskTitle: 'feat(User Sessions / API): Add refresh',
      files: [file('src/other.ts')],
    })).toMatchObject({ scope: 'user-sessions-api', subject: 'feat(user-sessions-api): add refresh' });
  });

  it('removes markdown and collapses multiline task titles', () => {
    const preview = service.createPreview({
      taskTitle: '## Add **safe**\n  checkpoint   restore.',
      files: [file('src/checkpoint/restore.ts')],
    });
    expect(preview.description).toBe('add safe checkpoint restore');
    expect(preview.subject).not.toContain('\n');
  });

  it('strips a leading task label', () => {
    expect(service.createPreview({
      taskTitle: 'Task # Add safe restore',
      files: [file('src/restore/index.ts')],
    }).description).toBe('add safe restore');
  });

  it('lowercases the first ASCII character of the description', () => {
    expect(service.createPreview({
      taskTitle: 'Implement Git status reader',
      files: [file('src/git/status.ts')],
    }).description).toBe('implement Git status reader');
  });

  it('keeps a generated subject within 72 characters', () => {
    const preview = service.createPreview({
      taskTitle: `Add ${'very-long-description-'.repeat(8)}`,
      files: [file('src/exceptionally-long-scope-name-that-is-truncated/file.ts')],
    });
    expect(preview.subject.length).toBeLessThanOrEqual(72);
    expect(preview.scope?.length).toBeLessThanOrEqual(24);
  });

  it('uses a timeline entry as a description fallback', () => {
    expect(service.createPreview({
      taskTitle: '',
      timeline: [{ title: 'Tests passed', detail: '42 checks' }],
      files: [file('src/core.ts')],
    }).description).toBe('tests passed 42 checks');
  });

  it('uses a single filename when title and timeline are empty', () => {
    expect(service.createPreview({ taskTitle: '', files: [file('src/config/settings.ts')] }).description)
      .toBe('update settings.ts');
  });

  it('uses a scoped workflow fallback for several files', () => {
    expect(service.createPreview({
      taskTitle: '',
      files: [file('src/auth/a.ts'), file('src/auth/b.ts')],
    }).description).toBe('update auth workflow');
  });

  it('uses a project fallback with no task evidence', () => {
    expect(service.createPreview({ taskTitle: '', files: [] })).toMatchObject({
      scope: null,
      description: 'update project files',
      subject: 'chore: update project files',
    });
  });

  it('sorts and de-duplicates the file list', () => {
    expect(service.createPreview({
      taskTitle: 'Fix order',
      files: [file('z.ts'), file('a.ts'), file('z.ts')],
    }).files).toEqual(['a.ts', 'z.ts']);
  });

  it('summarizes safe positive line counts', () => {
    expect(service.createPreview({
      taskTitle: 'Add changes',
      files: [
        file('src/a.ts', { additions: 5, deletions: 2 }),
        file('src/b.ts', { additions: 7, deletions: 3 }),
      ],
    })).toMatchObject({ fileCount: 2, additions: 12, deletions: 5 });
  });

  it('does not propagate invalid or negative line counts', () => {
    expect(service.createPreview({
      taskTitle: 'Update counters',
      files: [
        file('src/a.ts', { additions: Number.NaN, deletions: -2 }),
        file('src/b.ts', { additions: Number.POSITIVE_INFINITY, deletions: 1 }),
      ],
    })).toMatchObject({ additions: 0, deletions: 1 });
  });

  it('returns the same result for reordered files', () => {
    const a = file('src/git/a.ts', { additions: 1, deletions: 2 });
    const b = file('src/git/b.ts', { additions: 3, deletions: 4 });
    const left = service.createPreview({ taskTitle: 'Add Git overview', files: [a, b] });
    const right = service.createPreview({ taskTitle: 'Add Git overview', files: [b, a] });
    expect(left).toEqual(right);
  });

  it('returns message as a copy-ready subject without model metadata', () => {
    const preview = service.create({ taskTitle: 'Fix auth refresh', files: [file('src/auth/token.ts')] });
    expect(preview.message).toBe(preview.subject);
    expect(Object.keys(preview)).not.toContain('model');
  });

  it('offers a createCommitPreview compatibility entry point', () => {
    const input = { taskTitle: 'Fix auth refresh', files: [file('src/auth/token.ts')] };
    expect(service.createCommitPreview(input)).toEqual(service.createPreview(input));
  });
});
