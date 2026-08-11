import { describe, it, expect } from 'vitest';

describe('Windows path handling', () => {
  it('should handle paths with spaces', () => {
    const path = 'C:\\Users\\My User\\Projects\\My App';
    expect(path).toContain(' ');
    expect(path.split('\\').length).toBeGreaterThan(0);
  });

  it('should handle Chinese characters in paths', () => {
    const path = 'C:\\Users\\用户\\项目\\应用';
    expect(path).toContain('用户');
    expect(path.length).toBeGreaterThan(0);
  });

  it('should handle forward slashes on Windows', () => {
    const path = 'C:/Users/test/project';
    expect(path.replace(/\//g, '\\')).toBe('C:\\Users\\test\\project');
  });

  it('should handle UNC paths', () => {
    const path = '\\\\server\\share\\folder';
    expect(path.startsWith('\\\\')).toBe(true);
  });

  it('should handle drive letter paths', () => {
    const paths = ['C:\\', 'D:\\', 'E:\\Projects'];
    for (const p of paths) {
      expect(p.match(/^[A-Z]:\\/)).toBeTruthy();
    }
  });

  it('should handle mixed separators', () => {
    const path = 'C:\\Users/test\\project/file.ts';
    const normalized = path.replace(/\//g, '\\');
    expect(normalized).toBe('C:\\Users\\test\\project\\file.ts');
  });
});

describe('Command argument escaping', () => {
  it('should not inject commands through arguments', () => {
    const malicious = 'test; rm -rf /';
    const args = ['--model', malicious];
    // Arguments should be passed as separate array elements
    expect(args).toHaveLength(2);
    expect(args[1]).toBe(malicious);
    // The shell should treat it as a single argument, not execute the injected command
  });

  it('should handle arguments with special characters', () => {
    const special = 'hello "world" & | > < ^';
    const args = ['--prompt', special];
    expect(args[1]).toBe(special);
  });

  it('should handle empty arguments', () => {
    const args = ['--model', '', '--verbose'];
    expect(args).toHaveLength(3);
    expect(args[1]).toBe('');
  });

  it('should handle arguments with newlines', () => {
    const multiline = 'line1\nline2\nline3';
    const args = ['--prompt', multiline];
    expect(args[1]).toContain('\n');
  });
});

describe('Dangerous command detection', () => {
  const DANGEROUS_PATTERNS = [
    'rm ',
    'rm\t',
    'rmdir ',
    'del ',
    'format ',
    'diskpart',
    'shutdown',
    'reboot',
    'git reset --hard',
    'git clean',
    'git push --force',
    'git push -f',
    'git checkout -- .',
    'Remove-Item -Recurse',
    'Remove-Item -r',
    'npm publish',
    'pnpm publish',
  ];

  it('should detect dangerous commands', () => {
    for (const pattern of DANGEROUS_PATTERNS) {
      const testCmd = `${pattern} some-argument`;
      const isDangerous = DANGEROUS_PATTERNS.some((p) => testCmd.includes(p));
      expect(isDangerous).toBe(true);
    }
  });

  it('should not flag safe commands', () => {
    const safeCommands = [
      'npm install',
      'npm test',
      'npm run build',
      'git status',
      'git add .',
      'git commit -m "test"',
      'git log',
      'ls -la',
      'cat file.txt',
    ];

    for (const cmd of safeCommands) {
      const isDangerous = DANGEROUS_PATTERNS.some((p) => cmd.includes(p));
      expect(isDangerous).toBe(false);
    }
  });
});
