import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_SKILL_BYTES,
  SkillDiscoveryService,
  SkillReadError,
} from '../SkillDiscoveryService';

const TEMP_PREFIX = 'claude-workbench-skill-discovery-';

function writeSkill(root: string, directory: string, content: string | Buffer): string {
  const skillPath = path.join(root, directory, 'SKILL.md');
  fs.mkdirSync(path.dirname(skillPath), { recursive: true });
  fs.writeFileSync(skillPath, content);
  return skillPath;
}

function sha256(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function safelyRemove(directory: string): void {
  const target = path.resolve(directory);
  const tempRoot = path.resolve(os.tmpdir());
  if (path.dirname(target) !== tempRoot || !path.basename(target).startsWith(TEMP_PREFIX)) {
    throw new Error(`Refusing to remove unexpected directory: ${target}`);
  }
  fs.rmSync(target, { recursive: true, force: true });
}

describe('SkillDiscoveryService', () => {
  let root: string;
  let projectPath: string;
  let userHome: string;
  let projectSkills: string;
  let userSkills: string;
  let service: SkillDiscoveryService;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), TEMP_PREFIX));
    projectPath = path.join(root, 'project');
    userHome = path.join(root, 'user');
    projectSkills = path.join(projectPath, '.claude', 'skills');
    userSkills = path.join(userHome, '.claude', 'skills');
    fs.mkdirSync(projectPath, { recursive: true });
    fs.mkdirSync(userHome, { recursive: true });
    service = new SkillDiscoveryService({ userHome });
  });

  afterEach(() => safelyRemove(root));

  it('[SK-01] discovers a project skill and labels its source', () => {
    writeSkill(projectSkills, 'project-review', '# Review');

    expect(service.discover(projectPath).skills[0]).toMatchObject({
      name: 'project-review',
      source: 'project',
      status: 'available',
    });
  });

  it('[SK-02] discovers a user skill without modifying it', () => {
    const skillPath = writeSkill(userSkills, 'user-review', '# User review');
    const before = sha256(skillPath);

    const result = service.discover(projectPath);

    expect(result.skills[0]).toMatchObject({ name: 'user-review', source: 'user' });
    expect(sha256(skillPath)).toBe(before);
  });

  it('[SK-03] reads name and description from frontmatter', () => {
    writeSkill(projectSkills, 'directory-name', [
      '---',
      'name: "Readable Skill"',
      "description: 'Explains the workflow'",
      '---',
      '# Body',
    ].join('\n'));

    expect(service.discover(projectPath).skills[0]).toMatchObject({
      name: 'Readable Skill',
      description: 'Explains the workflow',
    });
  });

  it('[SK-04] falls back to the containing directory name', () => {
    writeSkill(projectSkills, 'fallback-name', '# No frontmatter');

    expect(service.discover(projectPath).skills[0].name).toBe('fallback-name');
  });

  it('[SK-05] recursively discovers nested skills in stable order', () => {
    writeSkill(projectSkills, path.join('nested', 'zeta'), '# Zeta');
    writeSkill(projectSkills, path.join('nested', 'alpha'), '# Alpha');

    expect(service.discover(projectPath).skills.map((skill) => skill.name)).toEqual([
      'alpha',
      'zeta',
    ]);
  });

  it('[SK-06] returns an empty result when skill roots do not exist', () => {
    expect(service.discover(projectPath)).toEqual({ skills: [], diagnostics: [] });
  });

  it('[SK-07] loads UTF-8 SKILL.md content on demand', () => {
    const content = '---\nname: 中文技能\ndescription: 只读内容\n---\n# 工作流';
    const skillPath = writeSkill(projectSkills, 'utf8', content);

    const document = service.readSkill(projectPath, { source: 'project', skillPath });

    expect(document).toMatchObject({ name: '中文技能', description: '只读内容', content });
  });

  it('[SK-08] rejects direct reads outside the selected source root', () => {
    const outside = writeSkill(path.join(root, 'outside'), 'escaped', '# Secret');

    expect(() => service.readSkill(projectPath, {
      source: 'project',
      skillPath: outside,
    })).toThrowError(expect.objectContaining<Partial<SkillReadError>>({
      code: 'outside_allowed_root',
    }));
  });

  it('[SK-09] skips directory symlinks that escape the allowed root', () => {
    const outsideRoot = path.join(root, 'outside');
    writeSkill(outsideRoot, 'escaped', '# Should not be read');
    fs.mkdirSync(projectSkills, { recursive: true });
    const linkPath = path.join(projectSkills, 'escaped-link');
    fs.symlinkSync(outsideRoot, linkPath, process.platform === 'win32' ? 'junction' : 'dir');

    const result = service.discover(projectPath);

    expect(result.skills).toEqual([]);
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'symlink_escape' }),
    ]));
  });

  it('[SK-10] allows a SKILL.md whose size is exactly 1MB', () => {
    const skillPath = writeSkill(projectSkills, 'exact-limit', Buffer.alloc(MAX_SKILL_BYTES, 0x61));

    const skill = service.discover(projectPath).skills[0];

    expect(skill).toMatchObject({ status: 'available', sizeBytes: MAX_SKILL_BYTES });
    expect(service.readSkill(projectPath, { source: 'project', skillPath }).content).toHaveLength(MAX_SKILL_BYTES);
  });

  it('[SK-11] marks a SKILL.md larger than 1MB and refuses to load it', () => {
    const skillPath = writeSkill(projectSkills, 'too-large', Buffer.alloc(MAX_SKILL_BYTES + 1, 0x61));

    const result = service.discover(projectPath);

    expect(result.skills[0].status).toBe('too_large');
    expect(result.diagnostics[0].code).toBe('too_large');
    expect(() => service.readSkill(projectPath, { source: 'project', skillPath }))
      .toThrowError(expect.objectContaining<Partial<SkillReadError>>({ code: 'too_large' }));
  });

  it('[SK-12] marks invalid UTF-8 and never returns replacement text', () => {
    const skillPath = writeSkill(projectSkills, 'invalid-utf8', Buffer.from([0xc3, 0x28]));

    const result = service.discover(projectPath);

    expect(result.skills[0].status).toBe('invalid_utf8');
    expect(() => service.readSkill(projectPath, { source: 'project', skillPath }))
      .toThrowError(expect.objectContaining<Partial<SkillReadError>>({ code: 'invalid_utf8' }));
  });

  it('[SK-13] preserves duplicate names from project and user sources', () => {
    const content = '---\nname: shared\n---\n# Skill';
    writeSkill(projectSkills, 'shared-project', content);
    writeSkill(userSkills, 'shared-user', content);

    expect(service.discover(projectPath).skills.map((skill) => skill.source)).toEqual([
      'project',
      'user',
    ]);
  });

  it('[SK-14] exposes no write path and leaves content byte-for-byte unchanged', () => {
    const skillPath = writeSkill(userSkills, 'immutable', '# Immutable');
    const before = sha256(skillPath);
    const descriptor = service.discover(projectPath).skills[0];

    service.readSkill(projectPath, descriptor);

    expect(sha256(skillPath)).toBe(before);
    expect('writeSkill' in service).toBe(false);
    expect('deleteSkill' in service).toBe(false);
  });

  it('[SK-15] permits an internal directory link while preserving containment', () => {
    const targetDirectory = path.join(projectSkills, 'target');
    const skillPath = writeSkill(projectSkills, 'target', '# Linked safely');
    fs.symlinkSync(
      targetDirectory,
      path.join(projectSkills, 'linked'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    const descriptor = service.discover(projectPath).skills[0];

    expect(descriptor.skillPath).toBe(skillPath);
    expect(service.readSkill(projectPath, descriptor).content).toBe('# Linked safely');
  });
});
