import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assertReleaseGit,
  buildId,
  createReleaseMetadata,
  projectReleaseMetadataContract,
  writeReleaseMetadataSnapshot,
} from '../../scripts/lib/release-metadata.mjs';

const COMMIT_SHA = '89abcdef0123456789abcdef0123456789abcdef';
const FAKE_COMMIT_SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const VALID_RELEASE_CONTRACT = {
  metadataSchemaVersion: 1,
  sqliteSchemaVersion: 7,
  approvedPublisherSubjects: [],
  approvedPublisherThumbprints: [],
};
const VALID_GIT = { branch: 'task15', dirty: false, commitSha: COMMIT_SHA };
const VALID_VERSIONS = {
  nodeVersion: 'v24.15.0',
  npmVersion: '11.12.1',
  electronVersion: '35.7.5',
  platform: 'win32',
  arch: 'x64',
};
const EXPECTED_METADATA_BYTES = [
  '{',
  '  "metadataSchemaVersion": 1,',
  '  "purpose": "candidate",',
  '  "productName": "Claude Workbench",',
  '  "appId": "com.claudeworkbench.app",',
  '  "version": "1.0.1-rc.1",',
  '  "channel": "rc",',
  '  "buildId": "1.0.1-rc.1+89abcdef0123.20260812T123456Z",',
  '  "branch": "task15",',
  `  "commitSha": "${COMMIT_SHA}",`,
  '  "commitShort": "89abcdef0123",',
  '  "dirty": false,',
  '  "buildTimeUtc": "2026-08-12T12:34:56Z",',
  '  "nodeVersion": "v24.15.0",',
  '  "npmVersion": "11.12.1",',
  '  "electronVersion": "35.7.5",',
  '  "sqliteSchemaVersion": 7,',
  '  "platform": "win32",',
  '  "arch": "x64",',
  '  "lockfileSha256": "7bdcad54a237d7c46f633f38509a375ac1f4367cf375f98520bf3ebfedadb9b8",',
  '  "releaseNotesSha256": "94ee88b63ff2bfc4e252593260193c7e428b307c3e85ea617ba98e776f273a0a"',
  '}',
  '',
].join('\n');
const roots: string[] = [];
let workspace = '';

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function writeReleaseContract(contract: unknown): void {
  fs.writeFileSync(
    path.join(workspace, 'src', 'shared', 'release-contract.json'),
    `${JSON.stringify(contract, null, 2)}\n`,
  );
}

function createCandidateMetadata() {
  return createReleaseMetadata({
    workspace,
    now: new Date('2026-08-12T12:35:00Z'),
    sourceDateEpoch: '1786538096',
    git: VALID_GIT,
    versions: VALID_VERSIONS,
  });
}

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-metadata-script-'));
  roots.push(workspace);
  fs.mkdirSync(path.join(workspace, 'docs', 'releases'), { recursive: true });
  fs.mkdirSync(path.join(workspace, 'src', 'shared'), { recursive: true });
  fs.writeFileSync(
    path.join(workspace, 'package.json'),
    `${JSON.stringify({ version: '1.0.1-rc.1' }, null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(workspace, 'package-lock.json'),
    `${JSON.stringify({
      version: '1.0.1-rc.1',
      packages: { '': { version: '1.0.1-rc.1' } },
    }, null, 2)}\n`,
  );
  writeReleaseContract(VALID_RELEASE_CONTRACT);
  fs.writeFileSync(
    path.join(workspace, 'docs', 'releases', '1.0.1-rc.1.md'),
    '# Claude Workbench 1.0.1-rc.1\n\nControlled Beta notes.\n',
  );
});

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('release metadata generator', () => {
  it('uses the exact tracked four-field release contract', () => {
    const trackedContract = JSON.parse(fs.readFileSync(
      path.resolve('src/shared/release-contract.json'),
      'utf8',
    ));

    expect(trackedContract).toEqual(VALID_RELEASE_CONTRACT);
  });

  it('projects metadata facts only after validating the strict four-field contract', () => {
    expect(projectReleaseMetadataContract(VALID_RELEASE_CONTRACT)).toEqual({
      metadataSchemaVersion: 1,
      sqliteSchemaVersion: 7,
    });
    expect(() => projectReleaseMetadataContract({
      metadataSchemaVersion: 1,
      sqliteSchemaVersion: 7,
    })).toThrow('Release contract');
  });

  it('rejects missing publisher policy and every unknown fifth contract key', () => {
    const invalidContracts = [
      { metadataSchemaVersion: 1, sqliteSchemaVersion: 7 },
      {
        metadataSchemaVersion: 1,
        sqliteSchemaVersion: 7,
        approvedPublisherSubjects: [],
      },
      {
        ...VALID_RELEASE_CONTRACT,
        unexpectedPolicy: [],
      },
    ];

    for (const contract of invalidContracts) {
      writeReleaseContract(contract);
      expect(() => createCandidateMetadata()).toThrow('Release contract');
    }
  });

  it('rejects malformed publisher subject and thumbprint arrays', () => {
    const malformedValues: unknown[] = [
      null,
      'CN=Claude Workbench',
      7,
      true,
      {},
      [null],
      [7],
      [true],
      [[]],
      [{}],
      [''],
      ['   '],
      ['\u200B'],
      ['\u2060'],
      ['CN=Publisher\u0000Policy'],
      [' CN=Claude Workbench'],
      ['CN=Claude Workbench '],
      ['x'.repeat(513)],
      ['duplicate', 'duplicate'],
      Array.from({ length: 65 }, (_, index) => `publisher-${index}`),
    ];

    for (const policyKey of [
      'approvedPublisherSubjects',
      'approvedPublisherThumbprints',
    ] as const) {
      for (const malformedValue of malformedValues) {
        writeReleaseContract({
          ...VALID_RELEASE_CONTRACT,
          [policyKey]: malformedValue,
        });
        expect(() => createCandidateMetadata()).toThrow('Release contract');
      }
    }
  });

  it('builds the exact basic-UTC build identifier', () => {
    expect(buildId({
      version: '1.0.1-rc.1',
      commitShort: '89abcdef0123',
      buildTimeUtc: '2026-08-12T12:34:56Z',
    })).toBe('1.0.1-rc.1+89abcdef0123.20260812T123456Z');
  });

  it('rejects the wrong branch, a dirty tree, and an invalid commit', () => {
    expect(() => assertReleaseGit({
      branch: 'main', dirty: false, commitSha: COMMIT_SHA,
    })).toThrow('task15');
    expect(() => assertReleaseGit({
      branch: 'task15', dirty: true, commitSha: COMMIT_SHA,
    })).toThrow('clean');
    expect(() => assertReleaseGit({
      branch: 'task15', dirty: false, commitSha: 'unknown',
    })).toThrow('invalid');
  });

  it('rejects a non-boolean clean state', () => {
    expect(() => assertReleaseGit({
      branch: 'task15', dirty: 0, commitSha: COMMIT_SHA,
    })).toThrow('clean');
  });

  it('derives one deterministic candidate snapshot from tracked bytes and injected facts', () => {
    const lockfile = fs.readFileSync(path.join(workspace, 'package-lock.json'));
    const releaseNotes = fs.readFileSync(
      path.join(workspace, 'docs', 'releases', '1.0.1-rc.1.md'),
    );
    const metadata = createCandidateMetadata();

    expect(metadata).toEqual({
      metadataSchemaVersion: 1,
      purpose: 'candidate',
      productName: 'Claude Workbench',
      appId: 'com.claudeworkbench.app',
      version: '1.0.1-rc.1',
      channel: 'rc',
      buildId: '1.0.1-rc.1+89abcdef0123.20260812T123456Z',
      branch: 'task15',
      commitSha: COMMIT_SHA,
      commitShort: '89abcdef0123',
      dirty: false,
      buildTimeUtc: '2026-08-12T12:34:56Z',
      nodeVersion: 'v24.15.0',
      npmVersion: '11.12.1',
      electronVersion: '35.7.5',
      sqliteSchemaVersion: 7,
      platform: 'win32',
      arch: 'x64',
      lockfileSha256: sha256(lockfile),
      releaseNotesSha256: sha256(releaseNotes),
    });
    expect(`${JSON.stringify(metadata, null, 2)}\n`).toBe(EXPECTED_METADATA_BYTES);
  });

  it('keeps non-empty publisher policy out of frozen metadata bytes', () => {
    writeReleaseContract({
      ...VALID_RELEASE_CONTRACT,
      approvedPublisherSubjects: ['CN=Owner Approved Publisher'],
      approvedPublisherThumbprints: ['0123456789ABCDEF'],
    });

    const metadata = createCandidateMetadata();

    expect(metadata).not.toHaveProperty('approvedPublisherSubjects');
    expect(metadata).not.toHaveProperty('approvedPublisherThumbprints');
    expect(`${JSON.stringify(metadata, null, 2)}\n`).toBe(EXPECTED_METADATA_BYTES);
    const written = writeReleaseMetadataSnapshot({ workspace, metadata });
    expect(fs.readFileSync(written)).toEqual(Buffer.from(EXPECTED_METADATA_BYTES, 'utf8'));
  });

  it('rejects malformed, fractional, pre-2000, and future SOURCE_DATE_EPOCH values', () => {
    const base = {
      workspace,
      now: new Date('2026-08-12T12:35:00Z'),
      git: { branch: 'task15', dirty: false, commitSha: COMMIT_SHA },
      versions: {
        nodeVersion: 'v24.15.0', npmVersion: '11.12.1', electronVersion: '35.7.5',
        platform: 'win32', arch: 'x64',
      },
    };
    for (const sourceDateEpoch of ['not-a-number', '1786538096.5', '946684799', '1786538401']) {
      expect(() => createReleaseMetadata({ ...base, sourceDateEpoch }))
        .toThrow('SOURCE_DATE_EPOCH');
    }
  });

  it('atomically writes only the fixed staging snapshot path', () => {
    const metadata = createReleaseMetadata({
      workspace,
      now: new Date('2026-08-12T12:34:56Z'),
      git: { branch: 'task15', dirty: false, commitSha: COMMIT_SHA },
      versions: {
        nodeVersion: 'v24.15.0', npmVersion: '11.12.1', electronVersion: '35.7.5',
        platform: 'win32', arch: 'x64',
      },
    });

    const written = writeReleaseMetadataSnapshot({ workspace, metadata });
    expect(written).toBe(path.join(
      workspace,
      'release-validation',
      'staging',
      'release-metadata.json',
    ));
    expect(JSON.parse(fs.readFileSync(written, 'utf8'))).toEqual(metadata);
    expect(fs.readFileSync(written)).toEqual(Buffer.from(EXPECTED_METADATA_BYTES, 'utf8'));
    expect(fs.readdirSync(path.dirname(written))).toEqual(['release-metadata.json']);
  });

  it('refuses to create release metadata from a fake Git injected through PATH', () => {
    const scriptDirectory = path.join(workspace, 'scripts', 'lib');
    const electronDirectory = path.join(workspace, 'node_modules', 'electron');
    const fakeBin = path.join(workspace, 'fake-bin');
    fs.mkdirSync(scriptDirectory, { recursive: true });
    fs.mkdirSync(electronDirectory, { recursive: true });
    fs.mkdirSync(fakeBin, { recursive: true });
    fs.copyFileSync(
      path.resolve('scripts/lib/release-metadata.mjs'),
      path.join(scriptDirectory, 'release-metadata.mjs'),
    );
    fs.writeFileSync(
      path.join(electronDirectory, 'package.json'),
      `${JSON.stringify({ version: '35.7.5' })}\n`,
    );
    fs.copyFileSync(process.execPath, path.join(fakeBin, 'git.exe'));
    fs.writeFileSync(
      path.join(workspace, 'rev-parse'),
      `process.stdout.write(process.argv.includes('--abbrev-ref') ? 'task15\\n' : '${FAKE_COMMIT_SHA}\\n');\n`,
    );
    fs.writeFileSync(path.join(workspace, 'status'), 'process.stdout.write(\'\');\n');

    const result = spawnSync(
      process.execPath,
      [path.join(scriptDirectory, 'release-metadata.mjs')],
      {
        cwd: workspace,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: fakeBin,
          SOURCE_DATE_EPOCH: '1786538096',
        },
        windowsHide: true,
      },
    );
    const outputPath = path.join(
      workspace,
      'release-validation',
      'staging',
      'release-metadata.json',
    );
    const generated = fs.existsSync(outputPath)
      ? JSON.parse(fs.readFileSync(outputPath, 'utf8')) as { commitSha?: string }
      : undefined;

    expect(generated?.commitSha).not.toBe(FAKE_COMMIT_SHA);
    expect(result.status).not.toBe(0);
    expect(fs.existsSync(outputPath)).toBe(false);
  });
});
