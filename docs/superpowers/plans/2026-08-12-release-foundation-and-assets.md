# Release Foundation and Original Assets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish 1.0.1-rc.1 as the single version, embed one validated clean-build metadata snapshot, and replace the unusable legacy icon dependency with an original tracked SVG/PNG/ICO asset.

**Architecture:** A Node metadata generator writes one ignored JSON snapshot that Vite embeds and electron-builder copies as a fixed resource. An SVG code-authored in this Task by the implementation agent under the project owner's instruction is rasterized by the locked Electron runtime into tracked derivatives whose bytes must regenerate identically on the supported locked Windows toolchain; installer and BrowserWindow paths resolve only tracked/build-copied assets. This is a parity check, not a cross-platform determinism claim.

**Tech Stack:** TypeScript, Zod, Vite define replacement, Node ESM scripts, Electron `nativeImage`, electron-builder/NSIS, Vitest.

## Global Constraints

- Work only on branch `task15`; target version/channel are `1.0.1-rc.1`/`rc`.
- Do not copy or inspect pixels from the rejected stable-worktree icon during implementation.
- The final SVG uses only original primitive geometry and no text, font, mascot, face, eye pair, starburst, knot, four-pane window, ribbon, octocat, or vendor mark.
- Keep editable SVG plus tracked PNG/ICO; do not commit temporary render frames or tool caches.
- All release builds reject dirty state, unknown commit, wrong branch, or package/lock mismatch.
- Keep one final commit by using `git commit --amend --no-edit`; do not tag, push, merge, or modify stable main.

---

### Task 1: Single-source version and build-time ReleaseMetadata

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `src/main/database/Database.ts`
- Modify: `src/shared/types/ipc.ts`
- Modify: `src/types.d.ts`
- Modify: `vite.main.config.ts`
- Modify: `src/main/release/VersionInfo.ts`
- Modify: `src/main/index.ts`
- Create: `src/shared/types/release.ts`
- Create: `src/shared/release-contract.json`
- Create: `src/main/release/ReleaseMetadata.ts`
- Create: `scripts/lib/release-metadata.mjs`
- Create: `docs/releases/1.0.1-rc.1.md`
- Test: `src/main/release/__tests__/ReleaseMetadata.test.ts`
- Test: `tests/release/release-metadata-script.test.ts`
- Modify test: `src/main/release/__tests__/VersionInfo.test.ts`

**Interfaces:**
- Produces: `ReleaseChannel = 'dev' | 'rc' | 'beta' | 'latest'`.
- Produces: `ReleaseMetadata`, `RuntimeMetadata`, `ReleaseVersionInfo`, `releaseMetadataSchema`, `publicReleaseVersionInfo(metadata, runtimeStatus)`.
- Produces: `createReleaseMetadata({ workspace, now, sourceDateEpoch, git, versions }): ReleaseMetadata` from the ESM script.
- Produces compile-time `__WORKBENCH_RELEASE_METADATA_JSON__: string`.
- Consumes: `package.json` version, Git HEAD/status, lockfile bytes, release-notes bytes, `SCHEMA_VERSION`, Node/npm/Electron versions.

- [ ] **Step 1: Write failing contract tests**

```ts
it('uses package.json as the only 1.0.1-rc.1 version source', () => {
  expect(packageJson.version).toBe('1.0.1-rc.1');
  expect(packageLock.version).toBe(packageJson.version);
  expect(packageLock.packages[''].version).toBe(packageJson.version);
});

it('rejects release metadata with an unknown commit or dirty tree', () => {
  expect(() => releaseMetadataSchema.parse({ ...validMetadata, commitSha: 'unknown' })).toThrow();
  expect(() => assertReleasableMetadata({ ...validMetadata, dirty: true })).toThrow('clean');
});

it('projects no source path, environment value, username, credential reference, or vault path', () => {
  const publicInfo = publicReleaseVersionInfo(validMetadata, validRuntimeStatus);
  expect(JSON.stringify(publicInfo)).not.toMatch(/C:\\Users|credential_ref|vault|secret-value/iu);
});
```

- [ ] **Step 2: Run focused tests and observe the missing-module/version failures**

Run (observed red): `& ([IO.Path]::Combine([Environment]::GetFolderPath([Environment+SpecialFolder]::System), 'WindowsPowerShell\v1.0\powershell.exe')) -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File .\scripts\release\tdd-evidence-launcher.ps1 -Phase red -CaseIds VER-01,VER-02,VER-03,VER-04,VER-05,VER-06,VER-07,META-08,META-09,META-10,META-11,META-12 -CommandId foundation-version-metadata -ChildArgumentsBase64 bm9kZQBub2RlX21vZHVsZXMvdml0ZXN0L3ZpdGVzdC5tanMAcnVuAHNyYy9tYWluL3JlbGVhc2UvX190ZXN0c19fL1JlbGVhc2VNZXRhZGF0YS50ZXN0LnRzAHRlc3RzL3JlbGVhc2UvcmVsZWFzZS1tZXRhZGF0YS1zY3JpcHQudGVzdC50cwBzcmMvbWFpbi9yZWxlYXNlL19fdGVzdHNfXy9WZXJzaW9uSW5mby50ZXN0LnRz; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }`


Expected: FAIL because `release.ts`, `ReleaseMetadata.ts`, and `1.0.1-rc.1` do not exist.

- [ ] **Step 3: Bump both package manifests without creating a tag**

Run: `npm version 1.0.1-rc.1 --no-git-tag-version`

Verify: `node -e "const p=require('./package.json'),l=require('./package-lock.json');if(p.version!==l.version||l.packages[''].version!==p.version)process.exit(1)"`

- [ ] **Step 4: Define the exact shared contract**

```ts
export const RELEASE_CHANNELS = ['dev', 'rc', 'beta', 'latest'] as const;
export type ReleaseChannel = (typeof RELEASE_CHANNELS)[number];

export interface ReleaseMetadata {
  metadataSchemaVersion: 1;
  purpose: 'candidate';
  productName: 'Claude Workbench';
  appId: 'com.claudeworkbench.app';
  version: string;
  channel: ReleaseChannel;
  buildId: string;
  branch: 'task15';
  commitSha: string;
  commitShort: string;
  dirty: boolean;
  buildTimeUtc: string;
  nodeVersion: string;
  npmVersion: string;
  electronVersion: string;
  sqliteSchemaVersion: number;
  platform: string;
  arch: string;
  lockfileSha256: string;
  releaseNotesSha256: string;
}

export interface LocalUpdateFixtureMetadata
  extends Omit<ReleaseMetadata, 'purpose' | 'version'> {
  purpose: 'local-update-fixture';
  version: '1.0.1-rc.0';
}

export type RuntimeMetadata =
  | { mode: 'release'; metadata: ReleaseMetadata }
  | { mode: 'local-update-fixture'; metadata: LocalUpdateFixtureMetadata }
  | { mode: 'development'; version: string; commit: 'unknown'; channel: 'dev'; dirty: true };

export interface ReleaseRuntimeStatus {
  packaged: boolean;
  signatureStatus: 'Signed' | 'NotSigned' | 'UnknownError' | 'HashMismatch' | 'NotTrusted' | 'Expired';
  productionFeedConfigured: boolean;
  licenseStatus: 'decision_required';
  privacyStatus: 'draft';
}

export interface ReleaseVersionInfo {
  version: string;
  channel: ReleaseChannel;
  buildId: string;
  commit: string;
  electronVersion: string;
  nodeVersion: string;
  sqliteSchemaVersion: number;
  agentRuntime: 'claude-code';
  packaged: boolean;
  signatureStatus: ReleaseRuntimeStatus['signatureStatus'];
  productionFeedConfigured: ReleaseRuntimeStatus['productionFeedConfigured'];
  licenseStatus: ReleaseRuntimeStatus['licenseStatus'];
  privacyStatus: ReleaseRuntimeStatus['privacyStatus'];
  releaseNotesSha256: string;
}
```

Use strict Zod objects, candidate version `1.0.1-rc.1`, 40-hex-or-longer lowercase commit SHA, ISO UTC time, SHA-256 lockfile hash, fixed product name, and exact `candidate`/`rc`/`win32`/`x64` assertions in release mode. The only alternate packaged union member is exact `purpose='local-update-fixture'`/`version='1.0.1-rc.0'`; `assertReleasableMetadata()` always rejects it, so it cannot enter a candidate context, Manifest, or gate. Runtime loading accepts it only when the packaged app version is exactly rc.0 and the isolated fixture build compiled `__WORKBENCH_LOCAL_UPDATE_FIXTURE__=true`; there is no runtime environment switch. Development fallback is a separate discriminated union and never passes through either packaged schema.

Add `src/shared/release-contract.json` initially with the two cross-runtime metadata facts owned by Foundation: metadata schema version and SQLite schema version. `Database.ts` imports its schema value instead of a private numeric constant; the Node generator reads the same JSON. Artifact Integrity Task 2A is the sole later owner of the reviewed contract expansion to the final strict four fields by adding empty `approvedPublisherSubjects` and `approvedPublisherThumbprints` policy arrays; after that migration the historical two-field object is invalid. Task 2A preserves already frozen metadata bytes through an explicit projection from the validated four-field contract, not by accepting the legacy shape. Those policy fields are not projected into `ReleaseMetadata`, and Artifact Task 3 only consumes them. Add `package.json.engines` as `{ "node": "^22.14.0 || ^24.0.0", "npm": ">=11.12.1 <12" }` and `packageManager: "npm@11.12.1"`; preflight reads and evaluates those fields rather than duplicating toolchain ranges, and the release context records the exact observed versions used for the candidate.

- [ ] **Step 5: Add the canonical RC release-notes source**

Create `docs/releases/1.0.1-rc.1.md` with the version/channel, controlled-Beta scope, unsigned status, local-acceptance-feed limitation, database-backup promise, known limitations, and exact independence statement. It is version controlled and is the only notes source; later disclosure work may expand its content but may not create a parallel notes file.

- [ ] **Step 6: Implement one deterministic metadata generator**

```js
export function buildId({ version, commitShort, buildTimeUtc }) {
  const stamp = buildTimeUtc.replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, 'Z');
  return `${version}+${commitShort}.${stamp}`;
}

export function assertReleaseGit({ branch, dirty, commitSha }) {
  if (branch !== 'task15') throw new Error('Release branch must be task15.');
  if (dirty) throw new Error('Release worktree must be clean.');
  if (!/^[0-9a-f]{40,64}$/u.test(commitSha)) throw new Error('Release commit is invalid.');
}
```

The normal generator always emits `purpose='candidate'`; it has no fixture switch. `SOURCE_DATE_EPOCH`, when present, must be a bounded integer UTC epoch; otherwise capture one current UTC instant and normalize it to whole seconds. Read no environment values except the variable's timestamp text, and emit no path. Hash `package-lock.json` and `docs/releases/1.0.1-rc.1.md` bytes with SHA-256. The CLI writes only `release-validation/staging/release-metadata.json` through an atomic writer. Subplan 5 owns the separate ignored-copy fixture generator and can emit only the exact fixture union member.

- [ ] **Step 7: Embed and load the snapshot**

In `vite.main.config.ts`, read only `WORKBENCH_RELEASE_METADATA_PATH`, resolve it, require it to equal the workspace's `release-validation/staging/release-metadata.json`, parse the file during build, and set:

```ts
define: {
  __WORKBENCH_RELEASE_METADATA_JSON__: JSON.stringify(
    process.env.WORKBENCH_RELEASE_METADATA_PATH
      ? fs.readFileSync(process.env.WORKBENCH_RELEASE_METADATA_PATH, 'utf8')
      : 'null',
  ),
}
```

Declare the compile-time string in `src/types.d.ts`. `loadRuntimeMetadata()` parses it once and freezes the result; in packaged mode it also reads `process.resourcesPath/release-metadata.json`, requires byte/hash equality with the embedded snapshot, and exits through the existing fatal-startup path on mismatch. Development fallback is an explicit `{mode:'development'}` value with `dev`/dirty/unknown and can never satisfy `assertReleasableMetadata()`.

- [ ] **Step 8: Replace runtime environment metadata reads**

`src/main/index.ts` calls `loadRuntimeMetadata({ packaged: app.isPackaged, resourcesPath: process.resourcesPath, fallbackVersion: app.getVersion(), runtimeVersions, sqliteSchemaVersion })`. Keep `buildVersionInfo()` as a compatibility wrapper around `publicReleaseVersionInfo(metadata, runtimeStatus)` until all existing tests/callers are migrated; immutable build metadata never fabricates post-build signature/feed facts, and the wrapper must no longer read arbitrary `process.env`. Until Subplan 2 supplies the shared runtime inspector, Main injects the conservative bounded status `signatureStatus='UnknownError'`, `productionFeedConfigured=false`, `licenseStatus='decision_required'`, and `privacyStatus='draft'`; it must not infer `NotSigned` merely from missing configuration. Subplan 2 replaces only that injected runtime-status provider, not the immutable metadata snapshot.

- [ ] **Step 9: Re-run focused tests and verify green**

Run: `git add -N -- src/main/release/__tests__/ReleaseMetadata.test.ts tests/release/release-metadata-script.test.ts src/main/release/__tests__/VersionInfo.test.ts src/shared/release-contract.json src/shared/types/release.ts src/main/release/ReleaseMetadata.ts src/main/release/VersionInfo.ts scripts/lib/release-metadata.mjs` (intent-to-add for foundation-version-metadata: makes new final-green inputs index-visible; it is not final staging or a commit).

Run (diagnostic green, not recorded): `node node_modules/vitest/vitest.mjs run src/main/release/__tests__/ReleaseMetadata.test.ts tests/release/release-metadata-script.test.ts src/main/release/__tests__/VersionInfo.test.ts`

Expected: PASS. The single approved observed green for `foundation-version-metadata` is deferred to Subplan 5's final observation phase, after every planned modification to its owned paths.

- [ ] **Step 10: Amend the reviewed task checkpoint**

Run: `git add package.json package-lock.json docs/releases/1.0.1-rc.1.md src/shared/release-contract.json src/shared/types/release.ts src/shared/types/ipc.ts src/types.d.ts src/main/database/Database.ts vite.main.config.ts src/main/release/ReleaseMetadata.ts src/main/release/VersionInfo.ts src/main/index.ts scripts/lib/release-metadata.mjs src/main/release/__tests__/ReleaseMetadata.test.ts src/main/release/__tests__/VersionInfo.test.ts tests/release/release-metadata-script.test.ts && git commit --amend --no-edit`

### Task 2: Original vector icon and verified tracked derivatives

**Files:**
- Create: `build-resources/app-icon.svg`
- Create generated: `build-resources/app-icon.png`
- Create generated: `build-resources/app-icon.ico`
- Create: `scripts/generate-app-icons.mjs`
- Create: `docs/legal/ASSET-NOTICES.md`
- Create test: `src/main/release/__tests__/AppIcon.test.ts`
- Modify: `.gitignore` only if a narrow rule is required; do not unignore `/build/` or `/tmp/`.

**Interfaces:**
- Produces: `renderIconFrames(svgPath, sizes): Promise<Map<number, Buffer>>`.
- Produces: `writeIco(frames): Buffer` with PNG-compressed 16/20/24/32/40/48/64/128/256 frames.
- Produces: asset hashes consumed by Manifest and `ASSET-NOTICES`.
- Consumes: locked Electron runtime only; no network, external image, font, or design-tool cache.

- [ ] **Step 1: Write failing asset tests**

```ts
const REQUIRED = [16, 20, 24, 32, 40, 48, 64, 128, 256];

it('contains the editable source and every required ICO frame', () => {
  expect(readIcoSizes('build-resources/app-icon.ico')).toEqual(REQUIRED);
  expect(readPngSize('build-resources/app-icon.png')).toEqual([512, 512]);
});

it('does not contain forbidden brand or mascot shapes/text', () => {
  const svg = readFile('build-resources/app-icon.svg');
  expect(svg).not.toMatch(/anthropic|claude|openai|chatgpt|codex|microsoft|github|visual studio|<text|<image|font-/iu);
});

it('does not reuse any rejected legacy hash', () => {
  expect(assetHashes).not.toContain('e1a4cd6d87d43e10781ac79bf5ba33869a74304a3156c3a32ab1c70c05746066');
  expect(assetHashes).not.toContain('95c49caa682233197e515571de5962d3f4d55ec809f3cba236c63d730d104ead');
  expect(assetHashes).not.toContain('047f755c7398181395c273afed6bf65dc190435ca0073f7358b339ab11dc5047');
});
```

- [ ] **Step 2: Run the focused test and observe missing assets**

Run: `npm exec vitest -- run src/main/release/__tests__/AppIcon.test.ts`

Expected: FAIL because `build-resources/app-icon.svg` and its derivatives do not exist.

- [ ] **Step 3: Author the canonical SVG from primitives**

Use a 256×256 viewBox and only these semantic groups:

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" role="img" aria-label="Workbench workflow">
  <rect x="24" y="30" width="208" height="164" rx="30" fill="#0B1F3A"/>
  <rect x="43" y="49" width="170" height="126" rx="20" fill="#F4FAFF"/>
  <path d="M38 194h180a14 14 0 0 1 14 14v12H24v-12a14 14 0 0 1 14-14Z" fill="#123B73"/>
  <path d="M78 105H128M128 105H178" stroke="#16B8C8" stroke-width="14" stroke-linecap="round"/>
  <rect x="57" y="84" width="42" height="42" rx="11" fill="#1467E8"/>
  <circle cx="128" cy="105" r="23" fill="#16B8C8"/>
  <path d="m178 78 27 27-27 27-27-27Z" fill="#F2A51A"/>
</svg>
```

Adjust coordinates only to improve optical balance; do not add facial details, window-control dots, letterforms, or external references.

- [ ] **Step 4: Implement locked-toolchain PNG/ICO regeneration**

Launch the locked Electron executable with `scripts/generate-app-icons.mjs`, wait for `app.whenReady()`, render the tracked inline SVG in one transparent offscreen BrowserWindow at 512×512, capture it once, derive the required frames with `nativeImage.resize({ quality: 'best' })`, write a 512×512 PNG, and pack each PNG into a little-endian ICO directory. Use sandboxing with Node disabled, sort frames ascending, and strip timestamps/paths/metadata.

- [ ] **Step 5: Generate the tracked derivatives**

Run: `npm exec electron -- scripts/generate-app-icons.mjs --write`

Then run: `npm exec electron -- scripts/generate-app-icons.mjs --verify`

Expected: `app-icon.png: MATCH`, `app-icon.ico: MATCH`, exit 0.

- [ ] **Step 6: Write the complete asset notice**

`docs/legal/ASSET-NOTICES.md` must include `RIGHTS_BASIS=PROJECT_OWNER_ATTESTATION_IN_TASK`, `COMMERCIAL_REDISTRIBUTION=AUTHORIZED_FOR_THIS_ORIGINAL_PROJECT_ASSET`, `AUTHORIZATION_EVIDENCE=TASK15_USER_INSTRUCTION_2026-08-12`, `AUTHORIZATION_RECORD_LOCATION=EXTERNAL_TASK_CONVERSATION_NOT_REPOSITORY`, `AUTHORIZATION_TEXT_HASH=NOT_RECORDED`, `AUTHORIZING_IDENTITY=NOT_RECORDED_IN_REPOSITORY`, `ATTESTATION_SCOPE=APP_ICON_ONLY`, `LEGAL_CONCLUSION=NONE`, `LEGAL_REVIEW=NOT_COMPLETED`, creator/contributor role (`IMPLEMENTATION_AGENT_UNDER_PROJECT_OWNER_INSTRUCTION`), record/creation date, creation method/tool versions or truthful `NOT_RECORDED`, prompt/reference disclosure, no-external-material declaration, SVG/PNG/ICO/generator hashes, every use site, reviewer/date/result, and:

> 该图标为 Claude Workbench 项目自有的通用工作流图形，不是 Anthropic、OpenAI 或其他厂商的官方商标或品牌资产。

Also state that the three temporary AI direction sketches were viewed for high-level direction only and no pixels or paths were copied, traced, or packaged. Scope the recorded attestation to this original icon only: it is not a project-software license, product-name clearance, vendor authorization, or public-GA legal approval.

- [ ] **Step 7: Verify small sizes and notice parity**

The test must calculate non-transparent bounds and foreground occupancy at 16/24/32; require a non-empty centered silhouette and at least 25% but no more than 90% occupied pixels. It must recompute every notice hash.

Run: `npm exec vitest -- run src/main/release/__tests__/AppIcon.test.ts`

- [ ] **Step 8: Amend the reviewed task checkpoint**

Run: `git add build-resources/app-icon.svg build-resources/app-icon.png build-resources/app-icon.ico scripts/generate-app-icons.mjs docs/legal/ASSET-NOTICES.md src/main/release/__tests__/AppIcon.test.ts && git commit --amend --no-edit`

### Task 3: Installer, NSIS disclosure, and BrowserWindow asset wiring

**Files:**
- Modify: `electron-builder.yml`
- Create: `build-resources/installer.nsh`
- Create: `build-resources/app-update.yml`
- Create: `src/shared/update-bootstrap-contract.json`
- Create: `scripts/generate-app-update-config.mjs`
- Create: `src/main/release/UpdateBootstrapConfig.ts`
- Create: `src/main/release/AppIcon.ts`
- Modify: `src/main/index.ts`
- Modify test: `src/main/release/__tests__/InstallerConfig.test.ts`
- Create test: `src/main/release/__tests__/AppIconPath.test.ts`
- Create test: `tests/release/app-update-config.test.ts`

**Interfaces:**
- Produces: `resolveAppIconPath({ packaged, resourcesPath, appPath }): string`.
- Produces: fixed packaged resources `app-icon.png` and `release-metadata.json`.
- Produces: a non-routing updater bootstrap resource containing only the deterministic cache-directory name required by electron-updater plus a reserved `.invalid` placeholder provider URL.
- Preserves: `appId=com.claudeworkbench.app`, `productName=Claude Workbench`, x64 NSIS, per-user/asInvoker, custom directory, desktop/Start shortcuts.

- [ ] **Step 1: Write failing installer/path tests**

```ts
expect(builderConfig).toContain('buildResources: build-resources');
expect(builderConfig.match(/build-resources\/app-icon\.ico/gu)).toHaveLength(4);
expect(builderConfig).toContain('include: build-resources/installer.nsh');
expect(builderConfig).toContain('deleteAppDataOnUninstall: false');
expect(resolveAppIconPath({ packaged: true, resourcesPath: 'R', appPath: 'A' }))
  .toBe(path.join('R', 'app-icon.png'));
```

Also assert no asset/config path uses `build/icon`, a stable-worktree path, a generated output directory, a temp path, a file association, a protocol, or a source-map include. Do not reject the legitimate Foundation-time `directories.output: release` or `files: dist/**/*` entries. Artifact Integrity Task 2A later migrates the output to `release-validation/staging/build-output` and updates this test; that later ownership does not rewrite Foundation's completed implementation chronology.

`app-update-config.test.ts` proves that `build-resources/app-update.yml` exactly regenerates from `src/shared/update-bootstrap-contract.json`, is copied to the default `resources/app-update.yml`, contains `provider: generic`, the single cache name `claude-workbench-updater`, and only `https://updates.invalid/disabled/` as a reserved non-routing bootstrap placeholder. It rejects credentials, query/fragment/userinfo, localhost/private/real production hosts, channel/update metadata, or any `publish` configuration. This file exists because electron-updater 6.8.9 unconditionally reads `updaterCacheDirName` before a real download; it is not a configured update feed.

- [ ] **Step 2: Run tests and observe existing build/icon failures**

Run (observed red): `& ([IO.Path]::Combine([Environment]::GetFolderPath([Environment+SpecialFolder]::System), 'WindowsPowerShell\v1.0\powershell.exe')) -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File .\scripts\release\tdd-evidence-launcher.ps1 -Phase red -CaseIds INS-13,INS-14,INS-15,INS-16,INS-17,INS-18,INS-19,INS-20 -CommandId foundation-installer -ChildArgumentsBase64 bm9kZQBub2RlX21vZHVsZXMvdml0ZXN0L3ZpdGVzdC5tanMAcnVuAHNyYy9tYWluL3JlbGVhc2UvX190ZXN0c19fL0luc3RhbGxlckNvbmZpZy50ZXN0LnRzAHNyYy9tYWluL3JlbGVhc2UvX190ZXN0c19fL0FwcEljb25QYXRoLnRlc3QudHMAdGVzdHMvcmVsZWFzZS9hcHAtdXBkYXRlLWNvbmZpZy50ZXN0LnRz; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }`


- [ ] **Step 3: Update electron-builder configuration**

Set `directories.buildResources: build-resources` and retain the Foundation-time `directories.output: release`; use `build-resources/app-icon.ico` for `win.icon`, installer, uninstaller, and header; add `nsis.include`; set `deleteAppDataOnUninstall: false`; exclude `dist/**/*.map`; and add:

```yaml
extraResources:
  - from: build-resources/app-icon.png
    to: app-icon.png
  - from: release-validation/staging/release-metadata.json
    to: release-metadata.json
  - from: build-resources/app-update.yml
    to: app-update.yml
```

Keep `files` limited to production bundles/package metadata, `asar: true`, the existing native unpack rules, `npmRebuild: false`, and artifact name `ClaudeWorkbench Setup ${version}.${ext}`. Keep `publish` absent. Artifact Integrity Task 2A later migrates the tracked output to the canonical staging directory, and Task 2D forces the locked electron-builder CLI to exact argv `['--win', '--publish', 'never']` under a scrubbed minimal environment with no CLI config override; this later migration is not part of Foundation's completed output. `scripts/generate-app-update-config.mjs --write/--verify` owns exact LF bytes; normal packaging runs only `--verify`. `UpdateBootstrapConfig` derives the main-owned cache resolver from the same tracked JSON and, in packaged mode, requires the resource bytes to equal the canonical generated bytes before constructing UpdateManager. The `.invalid` URL is never passed to `setFeedURL()`; only a separately validated `UpdateSourcePolicy` source may configure the client.

- [ ] **Step 4: Add the NSIS welcome disclosure**

```nsh
!macro customWelcomePage
  !define MUI_WELCOMEPAGE_TEXT "Claude Workbench 是独立第三方软件，与 Anthropic、OpenAI 及其关联公司不存在官方隶属、授权或背书关系。$\r$\n$\r$\n这是未签名的封闭 Beta 测试版本。"
  !insertmacro MUI_PAGE_WELCOME
!macroend
```

Do not use a draft privacy/Beta document as a license page and do not invent publisher metadata.

- [ ] **Step 5: Wire the same PNG into BrowserWindow**

`resolveAppIconPath()` returns `path.join(process.resourcesPath, 'app-icon.png')` only when packaged and `path.join(app.getAppPath(), 'build-resources', 'app-icon.png')` in development. Pass it to `new BrowserWindow({ icon, ... })`; no absolute literal is committed.

- [ ] **Step 6: Re-run focused tests**

Run: `git add -N -- build-resources/installer.nsh build-resources/app-update.yml src/shared/update-bootstrap-contract.json src/main/release/AppIcon.ts src/main/release/UpdateBootstrapConfig.ts scripts/generate-app-update-config.mjs src/main/release/__tests__/InstallerConfig.test.ts src/main/release/__tests__/AppIconPath.test.ts tests/release/app-update-config.test.ts` (intent-to-add for foundation-installer: makes new final-green inputs index-visible; it is not final staging or a commit).

Run (diagnostic green, not recorded): `node node_modules/vitest/vitest.mjs run src/main/release/__tests__/InstallerConfig.test.ts src/main/release/__tests__/AppIconPath.test.ts tests/release/app-update-config.test.ts`

Expected: PASS. The single approved observed green for `foundation-installer` is deferred to Subplan 5's final observation phase, after every planned modification to its owned paths.

- [ ] **Step 7: Amend the reviewed task checkpoint**

Run: `git add electron-builder.yml build-resources/installer.nsh build-resources/app-update.yml src/shared/update-bootstrap-contract.json scripts/generate-app-update-config.mjs src/main/release/UpdateBootstrapConfig.ts src/main/release/AppIcon.ts src/main/index.ts src/main/release/__tests__/InstallerConfig.test.ts src/main/release/__tests__/AppIconPath.test.ts tests/release/app-update-config.test.ts && git commit --amend --no-edit`

### Task 4: Authenticated release IPC and public projection parity

**Files:**
- Modify: `src/main/ipc/release.ts`
- Modify: `src/main/ipc/__tests__/release.test.ts`
- Modify: `src/shared/types/ipc.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/preload/__tests__/index.test.ts`
- Modify: `src/preload/__tests__/transport-surface.test.ts`
- Modify: `tests/typecheck/public-ipc-main.ts`
- Modify: `src/main/index.ts`

**Interfaces:**
- Consumes: `ReleaseVersionInfo` from Task 1.
- Produces: release handlers that accept exact empty tuples except `installUpdate([{ confirmed: true }])`.
- Consumes: `TrustedRendererIPCDependencies` and `assertTrustedMainFrame`.

- [ ] **Step 1: Write failing forged-frame and tuple tests**

```ts
await expect(invokeFrom(subframe, IPC_CHANNELS.RELEASE_GET_VERSION)).rejects.toThrow('trusted main frame');
await expect(invoke(IPC_CHANNELS.RELEASE_CHECK_UPDATE, 'extra')).rejects.toThrow('Invalid release request');
await expect(invoke(IPC_CHANNELS.RELEASE_INSTALL_UPDATE, { confirmed: true, url: 'https://evil.invalid' }))
  .rejects.toThrow('Invalid release request');
```

- [ ] **Step 2: Run release IPC/preload tests and observe the current permissive failures**

Run (observed red): `& ([IO.Path]::Combine([Environment]::GetFolderPath([Environment+SpecialFolder]::System), 'WindowsPowerShell\v1.0\powershell.exe')) -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File .\scripts\release\tdd-evidence-launcher.ps1 -Phase red -CaseIds SEC-55 -CommandId foundation-release-ipc -ChildArgumentsBase64 bm9kZQBub2RlX21vZHVsZXMvdml0ZXN0L3ZpdGVzdC5tanMAcnVuAHNyYy9tYWluL2lwYy9fX3Rlc3RzX18vcmVsZWFzZS50ZXN0LnRzAHNyYy9wcmVsb2FkL19fdGVzdHNfXy9pbmRleC50ZXN0LnRzAHNyYy9wcmVsb2FkL19fdGVzdHNfXy90cmFuc3BvcnQtc3VyZmFjZS50ZXN0LnRz; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }`


- [ ] **Step 3: Add strict schemas and sender authentication**

Use `z.tuple([])` for reads/check/download and:

```ts
const installTuple = z.tuple([z.object({ confirmed: z.literal(true) }).strict()]);
```

Call `assertTrustedMainFrame(event, dependencies)` before parsing or invoking every release action. Change preload `installUpdate(confirmed)` to send only `{ confirmed: true }`; false returns locally without IPC.

- [ ] **Step 4: Re-run focused and typecheck transport tests**

Run: `git add -N -- src/main/ipc/__tests__/release.test.ts src/preload/__tests__/index.test.ts src/preload/__tests__/transport-surface.test.ts` (intent-to-add for foundation-release-ipc: makes new final-green inputs index-visible; it is not final staging or a commit).

Run (diagnostic green, not recorded): `node node_modules/vitest/vitest.mjs run src/main/ipc/__tests__/release.test.ts src/preload/__tests__/index.test.ts src/preload/__tests__/transport-surface.test.ts`

Expected: PASS. The single approved observed green for `foundation-release-ipc` is deferred to Subplan 5's final observation phase, after every planned modification to its owned paths.

Run (supporting, not numbered evidence): `npm run typecheck:ipc`

- [ ] **Step 5: Run the complete subplan verification**

Run: `npm exec vitest -- run src/main/release/__tests__/ReleaseMetadata.test.ts src/main/release/__tests__/VersionInfo.test.ts src/main/release/__tests__/AppIcon.test.ts src/main/release/__tests__/InstallerConfig.test.ts src/main/release/__tests__/AppIconPath.test.ts src/main/ipc/__tests__/release.test.ts src/preload/__tests__/index.test.ts src/preload/__tests__/transport-surface.test.ts tests/release/release-metadata-script.test.ts`

- [ ] **Step 6: Amend the reviewed task checkpoint**

Run: `git add src/main/ipc/release.ts src/main/ipc/__tests__/release.test.ts src/shared/types/ipc.ts src/preload/index.ts src/preload/__tests__/index.test.ts src/preload/__tests__/transport-surface.test.ts tests/typecheck/public-ipc-main.ts src/main/index.ts && git commit --amend --no-edit`
