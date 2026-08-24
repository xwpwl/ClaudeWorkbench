# Claude Workbench Controlled Beta & Release Operations Design

> Date: 2026-08-12
> Status: approved for implementation
> Target: 1.0.1-rc.1 on the rc channel
> Release ceiling: PASS_FOR_CLOSED_BETA; PUBLIC_GA remains blocked

## 1. Outcome and hard boundaries

Task 15 turns the current technically usable Windows application into a controlled closed-Beta candidate whose exact installer a small external cohort can install, inspect, diagnose, provide feedback about, and uninstall without losing local data. Update behavior is acceptance-tested only through a non-releasable RC0 fixture and an isolated loopback feed; the pipeline does not distribute the candidate, and the installed RC1 contains neither that local-feed branch nor unsigned-update admission.

The implementation reuses the existing electron-builder/NSIS installer, UpdateManager, DiagnosticsExporter, StructuredLogger, CrashRecoveryManager, ProcessSupervisor, AppDatabase, CredentialStore, preload bridge, and settings/About surfaces. It does not create competing installer, updater, diagnostics, recovery, credential, or logging systems.

All source changes occur only in the task15 worktree and are committed only to task15. The implementation does not create a Git tag, push a remote, merge main, modify the stable main worktree, upload diagnostics, create a self-signed certificate, or claim a local update feed is a production feed.

This task does not add an OpenAI Agent Runtime, an OpenAI-to-Anthropic gateway, hosted compute, accounts, billing, cloud synchronization, collaboration, a plugin marketplace, new Agent roles, automatic model routing, a telemetry service, silent background updates, or forced updates.

The final automated status vocabulary is:

- PASS_FOR_INTERNAL_DEVELOPMENT
- PASS_FOR_CLOSED_BETA
- BLOCKED_FOR_PUBLIC_GA

No report, UI surface, manifest, or script may emit PUBLIC_GA_READY. A closed-Beta pass does not waive the separate blockers for trusted code signing, a production update feed, final software license, final privacy terms, product-name/legal review, named publishing entity and contact details, external testing, and a historically trustworthy cross-version update path.

## 2. Audit findings and selected approach

The task15 branch, stable main branch, and stated baseline initially resolve to commit eb1a07bb950769cf24d0fe5c61c710fed4da0fba. Both tracked worktrees were clean at audit time.

The existing application version is 1.0.0. A historical local installer named ClaudeWorkbench Setup 1.0.0.exe exists, but it predates the visible Git root, reports commit unknown and channel stable, is unsigned, and contains no trusted updater feed metadata. It is evidence that 1.0.0 has existed, but it is not a trustworthy provenance or updater starting artifact.

The selected version is 1.0.1-rc.1 because it is strictly greater than 1.0.0 under SemVer and electron-updater comparison rules. Using 1.0.0-rc.2 would be a downgrade from 1.0.0 and is prohibited.

The selected architecture is one release core with thin adapters:

1. package.json remains the single application-version source.
2. A build-time ReleaseMetadata snapshot binds that version to one clean Git commit, one rc channel, one UTC build time, one lockfile hash, and runtime/schema versions.
3. Existing runtime modules consume safe projections of that snapshot.
4. Existing electron-builder, UpdateManager, DiagnosticsExporter, AppDatabase, IPC, and renderer surfaces are extended rather than replaced.
5. Release scripts and acceptance checks consume the same snapshot and fail closed on inconsistency.

A script-only approach was rejected because it would allow UI, updater, and manifest facts to drift. A full release-domain rewrite was rejected because it would duplicate mature modules and exceed the minimum Task 15 scope.

## 3. Legacy icon provenance decision

The stable worktree contains an ignored build/icon.png and build/icon.ico plus an ignored tmp/imagegen/icon-chroma.png precursor. The files are not present in task15, are not in any reachable commit, and have no author, license, assignment, prompt record, or applicable commercial-use terms in the repository.

The precursor contains C2PA strings that claim gpt-image 2.0, trained algorithmic media, and OpenAI Media Service API. That metadata was not cryptographically verified, and even a valid generation assertion would not establish which account commissioned it, which terms applied, or who may commercially redistribute it. The transparent PNG removed that metadata. A Pillow conversion of the transparent PNG reproduces the ICO byte for byte, which establishes a reproducible derivation path but does not prove which historic tool invocation created it.

The rejected legacy-asset audit record is below. The exact machine paths were reported to the project owner during the audit; the committed record deliberately uses non-resolvable stable-worktree-local identifiers so it cannot become a machine-path dependency or disclose a workstation username.

| Audited source identifier | Format and dimensions | SHA-256 | Repository/history status |
| --- | --- | --- | --- |
| stable-worktree-local:tmp/imagegen/icon-chroma.png | PNG, 1254×1254, opaque chroma-key precursor | e1a4cd6d87d43e10781ac79bf5ba33869a74304a3156c3a32ab1c70c05746066 | ignored; absent from every reachable commit |
| stable-worktree-local:build/icon.png | PNG, 1254×1254, 8-bit RGBA | 95c49caa682233197e515571de5962d3f4d55ec809f3cba236c63d730d104ead | ignored; absent from every reachable commit |
| stable-worktree-local:build/icon.ico | Windows ICO, 16/24/32/48/64/128/256 PNG frames, 32-bit RGBA | 047f755c7398181395c273afed6bf65dc190435ca0073f7358b339ab11dc5047 | ignored; absent from every reachable commit |

Filesystem timestamps report a local source-to-transparent-PNG-to-ICO sequence on 2026-08-01 at approximately 20:34 China Standard Time. They are not treated as trustworthy authorship or creation-time evidence because filesystem timestamps can change during copying. An unreachable dangling Git tree contains the ignored paths but no associated reachable commit, author, review, or ownership record. No matching tracked asset, license, attribution, generation script, purchase evidence, or rights declaration exists in either worktree. Repository evidence does not indicate extraction from an installed third-party program, webpage, official application directory, or brand pack; however, the absence of such evidence cannot establish that no external reference was used. The only positive origin clue is the unverified OpenAI image-generation C2PA claim, which is a service-origin assertion rather than a vendor-logo license or a commercial redistribution grant.

The legacy files therefore have status PROVENANCE_UNKNOWN / RIGHTS_NOT_ESTABLISHED. They will not be copied, committed, transformed, traced, packaged, or referenced from task15. Their generic appearance is not treated as a rights grant.

## 4. Original brand-neutral application icon

The application receives an original geometric icon named Workbench Workflow, code-authored in this Task by the implementation agent under the project owner's instruction. The final art is not copied or traced from the three temporary direction sketches used during design selection.

The canonical source is a code-authored SVG in build-resources/app-icon.svg. It uses only primitive paths and shapes:

- a dark navy rounded local-workbench/window frame;
- a single stable base;
- exactly three plain workflow nodes using circle, rounded-square, and diamond geometry;
- two ordinary straight or orthogonal connectors;
- flat navy, cobalt, cyan, teal, and one restrained amber status accent;
- transparent exterior.

It contains no text, initials, font, mascot, face, eye pair, starburst, interlocking knot, four-pane window, ribbon, octocat, official color lockup, vendor mark, or shape obtained by recoloring, cropping, rotating, or overlaying a third-party mark.

The artwork is optimized around a bold silhouette and limited internal detail. Generated assets include a transparent PNG and a Windows ICO with 16, 20, 24, 32, 40, 48, 64, 128, and 256 pixel frames. Small-size verification checks dimensions, frame presence, non-empty alpha bounds, minimum foreground occupancy, and visual recognizability at 16, 24, and 32 pixels.

The version-controlled asset set is:

- build-resources/app-icon.svg: editable canonical source;
- build-resources/app-icon.png: application/window raster;
- build-resources/app-icon.ico: Windows executable, installer, uninstaller, shortcut, and header icon;
- scripts/generate-app-icons.mjs: tracked-output regeneration and ICO packaging using the locked Electron/Chromium renderer plus a small audited ICO writer; release verification requires byte parity on the supported locked Windows toolchain but does not claim cross-platform raster determinism;
- docs/legal/ASSET-NOTICES.md: provenance, ownership declaration, hashes, redistribution status, and use sites.

The generated PNG and ICO are committed because a clean release build must not depend on another worktree, an installed program, a web download, an image service, a temporary directory, or a designer cache. The generator is a maintenance and verification tool; normal packaging consumes only the tracked outputs and verifies that regeneration matches them. electron-builder copies the tracked app-icon.png as one fixed packaged resource, and BrowserWindow resolves that copy through process.resourcesPath in packaged mode and the tracked relative file in development. It never reaches back into the source worktree at runtime.

ASSET-NOTICES contains this exact statement:

“该图标为 Claude Workbench 项目自有的通用工作流图形，不是 Anthropic、OpenAI 或其他厂商的官方商标或品牌资产。”

That sentence is the project owner's required internal declaration from this Task, not a claim about any vendor's rights. ASSET-NOTICES records RIGHTS_BASIS=PROJECT_OWNER_ATTESTATION_IN_TASK, COMMERCIAL_REDISTRIBUTION=AUTHORIZED_FOR_THIS_ORIGINAL_PROJECT_ASSET, AUTHORIZATION_EVIDENCE=TASK15_USER_INSTRUCTION_2026-08-12, AUTHORIZATION_RECORD_LOCATION=EXTERNAL_TASK_CONVERSATION_NOT_REPOSITORY, AUTHORIZATION_TEXT_HASH=NOT_RECORDED, AUTHORIZING_IDENTITY=NOT_RECORDED_IN_REPOSITORY, ATTESTATION_SCOPE=APP_ICON_ONLY, LEGAL_CONCLUSION=NONE, and LEGAL_REVIEW=NOT_COMPLETED. This relies on the user's explicit Task authorization and does not invent a personal/corporate identity or imply vendor consent. Final publishing-entity, product-name, software-license, and legal review remain public-GA blockers.

ASSET-NOTICES uses a validated schema rather than free text. Required fields are asset name; creator/contributor record; commissioning/authorizing role; creation date; creation method; tool and version; whether prompts or reference images were used; the fact that three temporary AI direction sketches were viewed but no pixels or paths were copied/traced/packaged; external-material declaration; SVG/PNG/ICO hashes; generator hash; use sites; authorization evidence; commercial-redistribution scope; reviewer; review date; and review result. A missing field fails the asset gate.

Release Manifest records hashes for the SVG, PNG, and ICO. Package inspection reads file magic, ASAR/resource inventories, inline SVG, raster images, and every ICO frame; it rejects known forbidden logo assets, unapproved image hashes, and unexpected image resources. The rule-set version/hash and per-frame hashes enter evidence. Automated success is named NO_KNOWN_FORBIDDEN_MATCH; scripts never emit TRADEMARK_SAFE, BRAND_SAFE, or “no infringement.” A manual visual review bound to exact asset hashes records reviewer/date/result and explicitly states that it is not a legal conclusion. PASS_FOR_CLOSED_BETA requires a complete ASSET-NOTICES record, exact generator parity, the packaged-image allowlist scan, and that manual review.

electron-builder and every BrowserWindow use only these tracked relative asset paths. No configuration contains a stable-main, dist, release, temporary, installation-directory, or machine-absolute asset path.

## 5. Release metadata and provenance

ReleaseMetadata is generated once per release run and validated with a strict schema. It contains:

- productName;
- version;
- channel: dev, rc, beta, or latest;
- buildId;
- commitSha and commitShort;
- dirty;
- buildTimeUtc;
- nodeVersion, npmVersion, and electronVersion;
- sqliteSchemaVersion;
- platform and arch;
- lockfileSha256.

The target channel is rc. latest is reserved for a future stable release, beta for a future open Beta, and dev for development builds.

The release Build ID format is:

    1.0.1-rc.1+<git-short-sha>.<UTC-basic-timestamp>

One validated UTC timestamp is created at fresh release-run start and passed to all child stages. With no SOURCE_DATE_EPOCH it is the captured whole-second `now`; an explicitly supplied canonical decimal epoch may fix a controlled rebuild only from 2000-01-01 through that captured `now`, and every future second fails closed. Frozen/resume loading derives the epoch from existing metadata and never rereads ambient time or wall clock. The generated safe JSON lives only in the ignored release staging area, is embedded into the main-process bundle, and is copied into packaged resources under the fixed name release-metadata.json. The entire staging directory is never packaged.

Development builds may synthesize dev metadata and truthfully show dirty or unknown. Release mode rejects missing HEAD, dirty tracked or untracked source state, unknown commit, malformed version/channel/time, package/lock version mismatch, any branch other than task15, non-x64 Windows target, missing lockfile hash, or inconsistent metadata. No override can turn another branch into a closed-Beta pass. The final gate also requires stable main to remain at eb1a07bb950769cf24d0fe5c61c710fed4da0fba with clean tracked status.

Main process loads and freezes the metadata. Renderer receives only a strict safe DTO through authenticated IPC. About, Diagnostics, update policy, Release Manifest, installer filename, and acceptance checks compare against the same fields.

Release metadata never contains an absolute source path, username, environment-variable value, API key, token, credential_ref, vault path, signing secret, authenticated URL, or raw error object.

## 6. Fail-closed release commands

The existing scripts remain reusable components behind these public commands:

- release:preflight
- release:build:win
- release:signing-check
- release:verify-signature
- release:manifest
- release:sbom
- release:verify
- release:acceptance
- release:manual-evidence
- release:rc

release:rc is the final authoritative, ordered, stop-on-first-failure orchestrator with a hash-bound two-phase boundary. `release:rc --freeze` performs the early Git/package gate; script-disabled dependency bootstrap and pre-lifecycle verification; metadata preparation; context-bound preflight completion; signing-input inspection; Windows build; post-build signature verification for the installer, unpacked executable, and signable helpers; SBOM/notices generation; immutable Manifest; artifact/package verification; an inner artifact checksum ledger; and candidate freeze. It emits no Beta/GA gate. The Windows builder always receives an explicit `--publish never` policy through an argument-vector runner and a minimal child environment with electron-builder/Git-host publish tokens, CI/tag publication hints, and caller publish overrides removed; configuration absence alone is not treated as sufficient. `release:manual-evidence` collects GUI/visual evidence only for those exact frozen bytes. `release:rc --resume` reruns a read-only Git/package gate, loads rather than regenerates the frozen metadata/context, validates manual evidence, and performs production/install/update/uninstall acceptance including the installed uninstaller signature. It evaluates the gate in memory, writes final reports and the outer delivery ledger only in an exclusive pending directory, verifies them, atomically publishes the directory, re-verifies it, and only then writes the authoritative completion receipt and returns the terminal result. A failed delivery step leaves neither a canonical PASS report nor a completion receipt. It never uploads, tags, pushes, publishes, or changes channels.

Preflight emits an ignored structured JSON report and checks Git identity/cleanliness, branch policy, package-lock synchronization, supported Node/npm versions, Electron binary, Node and Electron better-sqlite3 ABI loading, version monotonicity, rc channel, icon generation parity, installer configuration, metadata consistency, migration/future-schema behavior, diagnostics sentinels, update-source policy, credential scan, forbidden-package paths, typecheck, lint, the complete test suite, and production build. The full Vitest suite runs exactly once with the fixed tracked `vitest.config.ts`, fixed `--no-cache`, and tracked built-in-only reporter, all bound through the child receipt; disabling the Vitest result cache keeps the policy-bound `node_modules` tree byte-identical across that command. The reporter emits one bounded LF-framed summary: exact file/test/pass/fail/skip/todo counts plus six opaque identifiers mapped privately by exact normalized tracked module path and exact Vitest `TestCase.fullName`, preserving every literal ` > ` hierarchy separator, to migration backup, current-schema advance, future-schema rejection, corrupt legacy safety, diagnostic sentinel redaction, and diagnostic size bounds. Each predicate must be completed and match exactly once; collapsed-space, different-nesting, basename, substring, and glob matches are forbidden. The shared strict count shape permits reconciled nonnegative zero discovery, while preflight report PASS additionally requires nonzero files/tests; a structurally valid FAIL may honestly retain zero files/tests after empty discovery or collection failure, remains serializable through the strict report schema, and never invents counts. Raw module paths, test names, failure text, and terminal prose never leave the reporter boundary, and counts are never scraped or synthesized.

When release:preflight is invoked directly, it performs an early clean-Git/package/version gate, quarantines any prior canonical report, completes the script-disabled dependency install and pre-lifecycle verification, and only then creates or refreshes the single ignored metadata snapshot before controlled lifecycle completion and the remaining checks. release:rc performs that same dependency/metadata preparation once, passes the opaque bootstrap identity only into preflight, and passes the same context plus hash-bound stage references—not the token—to later stages. Production preflight exports accept exact default-only objects and no `deps`/callback/path/command/environment seam; test dependency substitution exists only in one marker-extracted private core that cannot create production evidence. A module-private WeakMap moves each opaque bootstrap token irreversibly through BOOTSTRAPPED, METADATA_PREPARING, METADATA_PREPARED, and CONSUMED (or terminal POISONED), changing phase before awaits/writes and binding exact core/workspace/release-facts/metadata/context identities. Forged, cloned, cross-core, cross-context, concurrent, failed, or reused tokens never reach lifecycle/report work. A successful report is bound to its metadata hash; rerunning preparation invalidates the prior report.

The Task 2C preflight and Task 2D build-command threat boundary is explicit. Those commands run non-elevated on the reviewed Windows x64 workstation and trust OS-owned System32 plus administrator-owned, standard-user-read-only Program Files Node/Git installations. A separate tracked release-toolchain policy pins the reviewed Node executable, npm package tree, Git critical runtime closure, and dependency-bootstrap tree/lifecycle policy; it is never generated or updated automatically and does not reuse Task 0's evidence-toolchain contract. The Node parent locates the first native host only through the reviewed literal `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`, opening and hashing the ordinary non-reparse candidate, recording its Node-visible handle identity, and reopening/rechecking path/hash/identity immediately before launch while retaining the original handle. Node cannot prove the effective Windows DACL, deny-share semantics, native final path, or known-folder origin before that host executes; this is an explicit workstation-bootstrap residual, not an ambient-root, pre-launch ACL, or known-folder claim. To stay below Windows' command-line limit, a small fixed encoded loader receives one bounded strict stdin envelope only after the parent has installed stdin write/backpressure/error/finish/close, process error/exit/close, independent output-EOF/cap, and deadline handling, verifies the exact UTF-8 controller bytes against its embedded SHA-256, and only then creates the in-memory supervisor script block; truncated/multiple/extra/duplicate/reordered input, noncanonical Base64, invalid UTF-8, size/hash drift, write/EPIPE/close-before-finish failure, or malformed input all fail before target creation and enter the same parent kill/wait/pipe-close barrier and no script/helper is written to disk. The fixed loader argv plus encoded body must stay below the Windows command-line limit. The controller then uses `GetSystemDirectoryW`/`SHGetKnownFolderPath` and native owner/DACL/final-path checks to validate that host and the Program Files roots before creating a target. Its Win32 calls use only PowerShell 5.1/.NET Framework 4.8 in-memory `Reflection.Emit`/`DefinePInvokeMethod`, never `Add-Type`, a compiler, a helper, or TEMP output. The hash-bound in-memory supervisor is not a member of the inner target Job: it uses an outer self-owned kill-on-close Job as the forced-exit safety net, then creates the target suspended, assigns it to a no-breakaway kill-on-close inner Job, and resumes it only after assignment. Success and supervisor-handled failure require target/pipe completion and an inner-Job query of zero active members before a bounded receipt. Parent timeout, output overflow, malformed output, or exit before receipt kills and waits for the supervisor and pipes but yields only fail-closed `cleanup-unconfirmed`; even a valid receipt is provisional until controller close and both pipe EOFs, and OS kill-on-close recovery is not a cleanup receipt or basis for Stage PASS. The immutable production descriptor matrix contains no fixture descriptor. Three exact, single-occurrence marker-delimited private source boundaries bind the production controller, canonical descriptor literal, and parent protocol/cleanup engine to test-only extracted copies; real behavior uses test-owned transport/programs without expanding the production API, descriptor surface, or runtime hooks. Other release subprocesses must follow their own expressly reviewed boundaries unless a later plan explicitly migrates them to this runner. This does not claim resistance to administrator/kernel compromise, pre-existing arbitrary code in the parent Node process, replacement before that parent starts, or every concurrent same-user race. Direct `npm run release:preflight` is diagnostic and is not described as pre-JavaScript preload protection; only an in-memory result consumed by the reviewed `release:rc` flow can become candidate evidence.

The immutable production descriptor matrix contains exactly 34 raw-hash-bound, strictly parsed rows. Its Git subset applies one fixed no-optional-lock/no-replacement/no-system-or-global-config environment, audits candidate/private-main local config, index flags/stages/modes and untracked files, rejects replacement refs, and exposes no paths or raw output; behavior tests prove both index files retain the same identity, bytes, length, and nanosecond mtime. Machine protocols for the full-test summary and native ABI probes require exact UTF-8, one trailing LF, no CR/extra line/BOM/duplicate key, strict bounded shapes, and no raw output. Command reports are a strict union: PASS is category null plus exit 0; ordinary child failure is `child-nonzero` plus its real unsigned 32-bit non-zero exit; timeout/output-limit/execution/cleanup-unconfirmed/invalid-output/verification-failed carry null rather than an invented code. A trustworthy summary is retained even when the test command fails or violates zero-skip/discovery policy; invalid protocol has no counts, and later failures retain completed counts. The owner-reviewed policy fixes host Node v24.15.0 ABI 137/N-API 10, Electron 35.7.5 with Node v22.16.0 ABI 133/N-API 10, and better-sqlite3 13.0.2/SQLite 3.53.4 plus its Windows x64 native SHA; both probes must exact-match those facts. Build descriptors carry only private tokens: the runner derives `SOURCE_DATE_EPOCH` from the fixed metadata snapshot's canonical whole-second time, supplies the fixed metadata path only where required, binds its observed hash as a critical input, and never reads an ambient epoch or caller path.

Dependency installation is a trust-epoch boundary. Before a script-disabled `npm ci --ignore-scripts --no-audit --no-fund` succeeds, release code may load only Node built-ins, the separately reviewed external npm closure, and reviewed local bootstrap modules whose entire dependency closure is Node built-ins. Workspace `.npmrc` and root dotenv inputs are absent; an existing user `.npmrc` is made unreachable by the fixed NUL config/minimal environment and is not itself a blocker. After installation, package/lock/source bytes and both Git worktrees are rechecked and the ordinary pre-lifecycle dependency tree must match the tracked policy using the exact descriptor-tree row byte order, not the differently key-sorted general canonical JSON helper. At that point a narrow pre-lifecycle lease may bind and import only Zod plus the tracked report schema, so a later lifecycle failure can still publish a strict FAIL prefix; SemVer, node-abi, security/probe/application modules remain unimported until controlled lifecycle completion and final binding. Only a fixed reviewed list of lifecycle payloads may run through the owned runner; the final dependency tree and exact literal post-install package/entry/workspace tables include Zod, SemVer, node-abi, the fixed `better-sqlite3/win32-x64` loader/native file, all command configs, and the six reviewed test modules. The public binding object is plain point-in-time data; private pre-/post-lifecycle leases hold/recheck identities only around protected imports and close all handles in terminal `finally`, while every later child is separately protected by the trusted runner. Frozen loading first stably reads metadata, derives its epoch without ambient time, runs a private read-only gate, constructs context, validates final bindings under the private lease, and only then imports Zod/report-schema and verifies the PASS report. The Task 2D entry is built-in-only until it invokes the fixed bound-preflight-report loader; it never imports/parses the schema before final binding, and repeats the point-in-time binding check immediately before the runner-owned build. The post-install, bound-report, and frozen-context loaders are asynchronous and zero-write. A prior canonical preflight report is moved, while held and identity-checked, to an exclusive random stale sibling before a fresh attempt and is never pathname-deleted; report existence alone is never a success signal. The fixed reports and staging directories are created one component at a time and identity-bound. Metadata is published only by a private fixed-path writer using exact pretty JSON plus LF, an exclusive same-directory temp and held parent/file rechecks; it never calls the weaker recursive Foundation CLI writer or the generic key-sorting report writer.

P0 failure produces a non-zero exit code and prevents installer generation. Later stages refuse to run without a successful report bound to the current commit, metadata hash, and lockfile hash. Individual developer commands remain usable, but only the orchestrator can produce a release-candidate gate report.

The process is provenance-rebuildable from a documented clean commit, lockfile, locked toolchain, tracked resources, release notes, and fixed metadata timestamp. It does not claim byte-for-byte reproducible NSIS/PE output unless two independent clean builds with the same SOURCE_DATE_EPOCH produce equal artifact hashes. The two-build experiment and any differing hash/timestamp/container fields are recorded honestly.

Generated validation reports, installers, unpacked applications, feeds, diagnostic ZIPs, test userData, databases, logs, SBOMs, manifests, and checksums remain ignored. Only source, tests, tracked assets, scripts, configuration templates, and documentation are committed.

## 7. Windows installer, shortcuts, and data retention

The existing electron-builder/NSIS configuration remains the sole packaging system. It continues to target Windows 10/11 x64 with per-user installation, asInvoker execution level, selectable installation directory, desktop shortcut, Start Menu shortcut, and normal uninstall. Upgrade identity is frozen to appId com.claudeworkbench.app and productName Claude Workbench for this task; the candidate makes no new file-association or URL-protocol claim.

The artifact name is ClaudeWorkbench Setup 1.0.1-rc.1.exe. Application executable, installer, uninstaller, desktop shortcut, Start Menu shortcut, installer header, and every BrowserWindow consume the tracked Workbench Workflow asset.

A small NSIS include adds the independent-third-party statement to an appropriate installer information/welcome surface without presenting draft Beta terms as a final license agreement and without inventing a publisher identity.

Default uninstall removes application files and shortcuts but retains application userData, database, settings, provider metadata, safeStorage-backed credentials, task history, checkpoints, and user projects. Task 15 does not add a risky data-removal checkbox unless the implementation can display the exact application-owned directory, default it off, require a second confirmation, and prove it cannot reach user projects. The minimum selected design therefore documents a separate explicit cleanup procedure and keeps uninstall preservation as the tested default.

Acceptance uses isolated paths containing spaces and Chinese characters, validates 125% and 150% display scale, verifies shortcut targets/icons, checks the uninstaller icon, and proves program removal plus user-data/project retention.

## 8. Honest code-signing preparation

No certificate is fabricated. Signing inputs may come only from Windows Certificate Store, CSC_LINK/CSC_KEY_PASSWORD or CI secrets, and a future audited cloud-signing adapter. Secrets are detected by presence and never printed.

release:signing-check runs before electron-builder and validates the configured signing-source class, timestamp-service policy, approved-publisher policy, and expected executable inventory without printing or opening private material. It may validate validity dates and Code Signing EKU for inspectable Windows Certificate Store public certificates; `CSC_LINK` or cloud credentials that cannot be inspected without opening private signing material are recorded as `configured_uninspected`, never guessed valid or invalid. Without a certificate it returns a truthful NotSigned result suitable for closed Beta and blocks any signing-only stage. Post-build Authenticode evidence is authoritative for the certificate actually applied.

release:verify-signature uses one tracked, fixed-command contract for Get-AuthenticodeSignature on Windows for the packaged main executable, installer, uninstaller, and signable helpers; release tooling and runtime consume the same command bytes/schema, and no loose PowerShell source is packaged. Normalized outcomes are Signed, NotSigned, UnknownError, HashMismatch, NotTrusted, or Expired. Only a valid trusted result may be labeled Signed.

release:verify invokes both signing-check and verify-signature. Before installation it verifies the unpacked main executable, installer, and packaged helpers. NSIS normally materializes the uninstaller only during installation, so isolated install acceptance verifies that file afterward and binds its hash/status into the acceptance report. A future Signed result also requires the certificate subject or thumbprint to match an owner-approved allowlist; a merely cryptographically valid but unapproved signer is NotTrusted.

The current expected candidate status is NotSigned. About and Beta documentation state “此测试版本尚未进行代码签名”; Manifest contains signatureStatus: NotSigned; SmartScreen risk is explicit; the public-GA gate remains blocked.

## 9. RC updater and isolated local feed

UpdateManager remains the only updater. Its existing no-auto-download, no-auto-install-on-quit, no-downgrade, explicit download, and explicit install behavior is preserved.

UPDATE_FEED_URL is read only by the main process. Renderer cannot provide or mutate it. URL validation rejects user information, non-empty query strings, fragments, non-HTTP protocols, non-normalized hosts, unexpected ports/paths, and production HTTP. The RC1 candidate compiles only the `unconfigured|production` policy; production requires HTTPS and an explicit host/path allowlist, which remains empty for this Task. HTTP loopback and truthful NotSigned admission are compiled only into the isolated, non-releasable RC0 fixture source copy through a static build constant; RC1 bundle scans require those branches and any runtime local-acceptance switch to be absent. The fixture accepts only literal 127.0.0.1 or ::1, not localhost names/private-network addresses, and forbids redirects. Production redirect response headers and every resulting request target are revalidated through cancellable hooks on electron-updater's dedicated session; a transition to another scheme, host, port, path prefix, or address class is cancelled. Feed URLs never enter logs, diagnostics, metadata, or Renderer DTOs.

Because electron-updater 6.8.9 unconditionally reads `updaterCacheDirName` before downloading, the package includes a tracked `app-update.yml` bootstrap resource generated from a tracked cache-name contract. It contains only `provider: generic`, deterministic cache name `claude-workbench-updater`, and reserved non-routing `https://updates.invalid/disabled/`. The Main process verifies its exact bytes, never passes that placeholder to `setFeedURL()`, and refuses checks while no separately validated source exists. There is no electron-builder publish configuration; this bootstrap is not an update feed.

The build channel is fixed to rc, allowPrerelease is enabled only for that channel, and downloaded versions must be greater than the current version with an rc prerelease identifier. An rc client accepts only the normalized rc metadata/artifact path and never silently switches to latest. Automatic checking remains off by default and may run only when the existing user setting explicitly enables it; auto-download and auto-install remain false in all cases. Update UI displays target version, normalized release notes, total size, channel, feed class, hash-verification status, and signature status. It shows “更新源：尚未配置” when no source exists.

electron-updater's feed SHA-512 is verified against the downloaded binary before installation. The downloaded file also receives Windows signature inspection. Only the non-releasable RC0 fixture may, after the UI truthfully shows NotSigned and the user gives the separate install/restart confirmation, accept the loopback-served RC1 installer for this isolated acceptance run. The installed RC1 itself contains no local-feed/runtime-switch or unsigned-update-admission branch. Hash mismatch always deletes or quarantines the invalid download and rejects installation.

A local static server binds to a random loopback port, serves generated rc metadata and artifacts, records no credentials, and is labeled local acceptance in every report. It is never written into application defaults or described as a production feed.

The historical 1.0.0 artifact cannot perform a truthful updater test because it lacks a feed and trusted provenance. Task 15 therefore does not claim a real 1.0.0-to-1.0.1-rc.1 updater success. It performs:

1. feed schema, discovery, notes, size, channel, and download/hash failure acceptance;
2. a controlled fixture update from a clearly labeled 1.0.1-rc.0 test build to 1.0.1-rc.1 when technically feasible;
3. separate installer-over-install upgrade/data-retention acceptance;
4. an explicit blocked result for the historical updater chain.

## 10. Database compatibility and pre-update backup

AppDatabase remains authoritative for schema version 7 and transactional migrations. Its existing future-schema rejection is extended so startup reports a safe actionable error, keeps the database unopened for writes, exposes the backup directory through a safe user action, and permits diagnostics export without creating or overwriting a replacement database.

Because normal bootstrap currently exits when AppDatabase initialization throws, main gains a deliberately limited database-unavailable mode for the typed future-schema error only. It creates no AppDatabase and registers only release metadata, sanitized system information, internal allowlisted log/error aggregates, restricted diagnostics export, open-application-backups-folder, and quit IPC. It exposes no raw-log, log-tail, or open-log IPC. It loads a recovery-only Renderer state with no provider, task, project, settings-write, update-install, or workflow IPC. DiagnosticsExporter is adapted to accept an explicit database-unavailable summary rather than duplicated. Displayed database/backup locations are platform-relative labels; Main alone may open the fixed application-owned backup directory.

Before UpdateManager permits quitAndInstall, AppDatabase creates a timestamped backup under an application-owned backup directory using the database engine's safe backup facility. It verifies the backup header, opens it read-only, runs integrity_check, records source and backup schema versions, and returns a safe relative display name rather than a full user path. Backup failure blocks installation but does not block normal use or diagnostics.

Update or migration failure retains both original and backup. The application does not claim executable rollback. Automatic downgrade remains disabled, and a higher-schema database is never overwritten by an older build.

## 11. Diagnostics and Beta feedback

DiagnosticsExporter remains the only diagnostic bundle writer. Its allowlisted ZIP and recursive redaction are expanded through strict projectors for:

- release metadata and install method;
- signing and updater status;
- database schema and integrity state;
- managed-process counts and categories;
- crash-recovery aggregate status;
- public provider counts/capability categories;
- renderer error count and recent error categories;
- test/acceptance feature flags.

Unknown fields fail closed. Paths are reduced to safe labels or application-relative placeholders. credential, credentialRef, credential_ref, vault, vaultPath, Authorization, Cookie, Password, tokens, authenticated URLs, user home paths, source code, prompts, Git diffs, provider raw responses, SQLite databases, and vault files are denied.

Sentinel tests scan ZIP entry names and contents, JSON, JSONL, Markdown, manifest, update log, crash metadata, feedback reports, release artifacts, and packaged file lists. Existing credential and artifact security scans stay active.

Beta Feedback is a narrow extension of existing diagnostics and safe file-dialog patterns, not a remote service. Entrypoints appear in About, Help, task error UI, and Crash Recovery where practical. The user may copy a safe template, save a local Markdown report, explicitly export diagnostics, or open one preconfigured HTTPS feedback page. No URL means local-only behavior. Renderer cannot supply the URL. Main revalidates and opens only one fixed, reviewed HTTPS origin/path and rejects credentials, fragments, non-empty or secret-bearing queries, nonstandard ports, and any Renderer-provided URL. It performs no implicit network preflight; redirects after handoff belong to the external site/system-browser boundary and are documented as such.

The template includes version, Build ID, Windows version, install/upgrade choice, task type, reproduction steps, expected result, actual result, repeatability, and willingness to provide diagnostics. It never prepopulates code, prompt text, file contents, credentials/references, vault paths, name, or email. Diagnostics, system information, performance summary, logs, and screenshots are always explicit user choices and default off. Nothing is uploaded automatically.

## 12. IPC and runtime trust boundaries

All touched release, updater, diagnostics, feedback, database-backup, and file-opening IPC handlers use strict Zod tuple schemas, authenticated WebContents, trusted main-frame checks, and exact packaged/development renderer origins. Renderer expresses intent only and never passes an arbitrary feed URL, filesystem target, signing path, command, artifact path, metadata object, or provider secret.

Main process recomputes release/update/signature/backup state. Public DTOs are explicit projections. Navigation and new-window handling compare normalized origins/paths rather than permissive prefix matching. Renderer remains sandboxed with contextIsolation enabled and Node integration disabled.

Structured logs receive bounded safe fields only. Raw process environments, signing secrets, feed credentials, full local paths, raw updater errors, and child-process output are redacted or omitted.

## 13. Manifest, checksums, SBOM, and dependency notices

release-manifest.json contains the approved metadata, signature status known at immutable-artifact time, artifact name/size/SHA-256, Electron/Node/schema/lockfile versions, preflight test summary, release-notes hash, and tracked asset hashes. It contains relative names only. It does not contain the final closed-Beta gate result, acceptance result, or its own hash.

The artifact inventory includes the installer, unpacked package summary, updater metadata where generated, SVG/PNG/ICO, SBOM, third-party notices, and version-controlled release notes. Files are hashed from binary bytes after final packaging/signature state. A manifest is invalidated if any recorded artifact changes.

Artifact finalization uses two acyclic checksum ledgers:

1. build and any real signing finish;
2. post-build signature verification records final executable hashes/status for the installer, unpacked executable, and signable helpers; the not-yet-materialized NSIS uninstaller is explicitly deferred to install acceptance and is not a gate item yet;
3. release:sbom writes the external SBOM/notices, then reconciles them against the actual packaged production closure;
4. release:manifest writes the immutable artifact manifest and references the pre-manifest signature-report hash; it contains no final gate, acceptance, or self hash;
5. release:verify rechecks final bytes, package/asset allowlists, embedded/resource metadata, SBOM/notices parity, signing state, and Manifest consistency;
6. ARTIFACT_SHA256SUMS.txt covers immutable artifacts and verification inputs, excludes itself, and is verified before candidate freeze;
7. hash-bound manual evidence and release:acceptance write separate install/update/uninstall/performance reports; install acceptance creates the sole final uninstaller signature item;
8. the final gate is evaluated in memory; JSON/Markdown report bytes and outer SHA256SUMS.txt are created beneath an exclusive pending delivery directory, with the report referencing the Manifest, inner checksum ledger, verification, and acceptance hashes;
9. the outer ledger covers the inner ledger plus all final evidence/reports under their eventual canonical relative names and excludes itself; pending bytes are verified, the entire directory is atomically published, and canonical bytes are verified again;
10. only then is an atomic non-ledger completion receipt written with the context, outer-ledger hash, final-report hash, and terminal status. The receipt is the sole authoritative success marker. Any publish/reverify/receipt failure quarantines or removes the canonical delivery before returning nonzero.

No artifact asserts the result of a check that depends on that artifact's own hash. The final report does not claim that its own outer ledger or completion receipt passed; that fact exists only in the later receipt. A post-final `release:verify --check-only --no-write` requires the receipt, snapshots its hash/mtime, the outer `SHA256SUMS.txt` file's own hash/mtime, every inner/outer-ledger entry, and the complete canonical delivery relative-name set, recomputes checks entirely in memory, and then proves the receipt, ledger file, all covered files, and the file set are unchanged with no addition or deletion.

npm sbom --package-lock-only --omit=dev --sbom-format=cyclonedx generates the base CycloneDX JSON from the locked production dependency graph. A package-inventory reconciliation then adds or verifies distributed runtime components that are not represented by that closure, including the Electron runtime (and its recorded Chromium/Node versions), native better-sqlite3 binary, and any dependency present in ASAR/unpacked resources despite being declared as a development build dependency. Component facts come from the installed locked package metadata, bundled license files, Electron runtime metadata, and actual packaged inventory rather than guesses. Every packaged runtime/native component must map to one SBOM component and notice entry.

The accompanying notice generator writes THIRD_PARTY_NOTICES.txt with package/component, resolved version, detected license expression, license-file source, homepage/repository, unknown-license marker, copyleft-risk marker, and dual-license marker. Unknown facts remain UNKNOWN and fail the applicable release gate; scripts do not guess.

Package composition remains allowlist-oriented. The installer may include production bundles, required production dependencies/native modules, the fixed release metadata resource, and approved application assets. It rejects tests, coverage, docs not required at runtime, release-validation, update-feed staging, user databases, logs, .env files, credentials, signing material, temporary conversion files, designer caches, and source maps when production debugging policy does not explicitly require them. Low-risk trimming may remove only those categories and unused duplicate/icon/language resources; it must not remove Monaco Diff, better-sqlite3, the Agent SDK, Crash Recovery, or Provider Center.

The repository has no authoritative root software license. README's unsupported MIT statement is removed or replaced with “license decision required,” and docs/legal/LICENSE-DECISION-REQUIRED.md records the blocker. Task 15 never chooses MIT, GPL, proprietary terms, or any other license for the owner.

Unknown, ambiguous, dual-license, or copyleft production dependencies are not silently accepted for external closed Beta. The automated report requires either a resolved license conclusion or an explicit owner/legal acceptance record scoped to the exact package/version and risk. Otherwise closedBetaReady is false.

## 14. Legal, privacy, data-flow, and affiliation documents

The implementation adds:

- docs/legal/PRIVACY-DRAFT.md;
- docs/legal/BETA-TERMS-DRAFT.md;
- docs/legal/DATA-FLOW.md;
- docs/legal/THIRD-PARTY-NOTICES.md;
- docs/legal/ASSET-NOTICES.md;
- docs/legal/LICENSE-DECISION-REQUIRED.md;
- docs/beta/BETA-TESTING-GUIDE.md;
- docs/beta/KNOWN-LIMITATIONS.md;
- docs/beta/RELEASE-CHECKLIST.md;
- docs/beta/FEEDBACK-TEMPLATE.md;
- SECURITY.md, with an explicitly incomplete disclosure contact until the owner supplies one.

One version-controlled docs/releases/1.0.1-rc.1.md file is the release-notes source. Feed metadata, packaged About content, diagnostics, and Manifest consume or hash that exact file; generated summaries cannot diverge silently.

Runtime-openable legal/Beta documents use a version-controlled `build-resources/bundled-documents.json` catalog generated before packaging from an exhaustive ID→relative-path→SHA-256 allowlist. Vite embeds the exact catalog and electron-builder copies that catalog plus only the individually named documents. Main verifies embedded/resource catalog equality, containment, regular-file status, and file hash before opening. The runtime never depends on the post-build release-manifest.json. The tracked `docs/legal/THIRD-PARTY-NOTICES.md` is the packaged explanatory document; post-build `THIRD_PARTY_NOTICES.txt` and the SBOM are external release artifacts and are never read by electron-builder.

README links the Beta guide, release notes, privacy/data-flow/asset/license status, release commands, installation, controlled upgrade, default-preserving uninstall, local-data cleanup, and feedback process. It does not present draft legal text as final.

BETA-TESTING-GUIDE covers installation and SmartScreen; first-run and Provider setup; opening a project; read-only and editing tasks; permission allow/deny; Diff; Checkpoint and historical-session recovery; crash recovery; diagnostics; update checking; uninstall; data retention; and feedback. KNOWN-LIMITATIONS explicitly records unsigned SmartScreen risk, no production feed, only the Claude Code Agent Runtime, the inability of OpenAI-compatible Providers to run that Agent, model-specific WebSearch/WebFetch limits, non-Git Checkpoint boundaries, Windows native-module constraints, the untrusted historical updater chain, draft license/privacy, and product-name review. RELEASE-CHECKLIST separates automatic, evidence-backed manual, closed-Beta, and public-GA gates and uses the orthogonal status model.

Draft legal documents use conspicuous placeholders for legal entity, address, contact, jurisdiction, effective date, retention decisions, and reviewer. They do not claim legal review or final effect.

DATA-FLOW is derived from code and distinguishes local Workbench storage from data a user-selected Provider may receive or retain. It documents local project source, direct Provider calls, the absence of a Workbench hosted-compute server, safeStorage-backed credentials, database/log/backup locations using platform-relative labels, diagnostics inclusion/exclusion, crash recovery, credential/history/local-data deletion, and “默认不上传遥测或诊断信息.”

The following exact statement appears prominently in About, README, Beta documentation, and an appropriate installer surface:

“Claude Workbench 是独立第三方软件，与 Anthropic、OpenAI 及其关联公司不存在官方隶属、授权或背书关系。”

The statement does not imply vendor consent. Product name and trademark review remain public-GA blockers even after the original icon is accepted.

## 15. About and release UI

The existing About section becomes the single visible release-status surface. It shows Version, Channel, Build ID, abbreviated Commit, Signature Status, Update Source/Status, Release Notes, Export Diagnostics, Beta Feedback, Third-party notices status, Privacy Draft, and License Status.

Truthful default labels are:

- 代码签名：未签名测试版本
- 更新源：尚未配置
- 软件许可：发布前待确认

GA blockers use neutral warning treatment rather than a green all-clear status. Safe local documents open through main-process allowlisted resource actions, not arbitrary renderer paths. Existing update confirmation steps remain explicit.

## 16. TDD slices and acceptance

Every behavioral change starts with an observed failing focused test. Implementation is divided into reviewable slices:

1. version bump, release contracts, metadata creation/loading, and clean-tree preflight;
2. original icon source/generator/assets/notices and installer/window wiring;
3. signing checks, Manifest, checksums, SBOM, notices, and artifact scans;
4. updater source/channel/hash/signature policy and pre-update database backup;
5. diagnostics strict projections, path/secret sentinels, and Beta Feedback;
6. About/Help/Recovery/error entrypoints, affiliation copy, legal/Beta documents;
7. production packaging, local feed, install/upgrade/uninstall, performance, and security acceptance.

Focused tests cover the requested versioning, metadata, installer, signing, update, diagnostics, SBOM/license, feedback, IPC, secret-scan, package-list, and manifest-path cases without duplicating assertions for count inflation.

The ignored requirements evidence matrix assigns the sixty requested assertions stable IDs and records only requirement IDs, planned focused-test references, allowlisted command ID, red/green result category, UTC/monotonic sequence, and hashes of related tracked relative paths. It is appended atomically and hash-chained; the recorder never retains command argv, cwd, stdout, stderr, environment, raw errors, absolute paths, or secrets. Each slice records its behavioral red during implementation and its only green in a frozen final observation phase after the complete five-plan tracked-source chronology. The contract exports the exact green order and one path→last-slice mapping; the final collector compares final tracked bytes only with those last observations and rejects any later mutation. Every official recorder command enters through a checked-in Windows PowerShell launcher invoked from an OS-known-folder-derived absolute System32 executable. The project-side runtime trust anchor is the already-loaded, reviewed launcher code together with its literal four-entry SHA-256 table. The launcher's self-held read handle stabilizes only its pathname after load; it does not authenticate the launcher bytes, and replacement before PowerShell loads them is outside this closure. The four hashes are launcher literals, are never sourced from the project toolchain manifest, and have no automatic or caller-driven update path. Before any project content is read, the launcher canonical/non-reparse checks, opens, identity-binds, and retains all four project inputs; it then hashes only those held streams, strict-UTF-8 parses the held toolchain stream, validates an identity-bound Program-Files Node binary, and revalidates all four held project identities immediately before starting Node. Node and any descendants are assigned to kill-on-close Windows job containment, and exceptional cleanup closes stdin, terminates and confirms the job empty, disposes the Process, and only then releases the project handles. It also builds a minimal PATH-free environment without Node/runtime injection variables, fixes cwd, and starts Node without a shell using an exactly quoted argument array plus a fresh per-process environment-and-pipe challenge. Only that official launcher route is preload-safe. The npm compatibility alias exits without invoking the recorder, while direct Node entry is unsupported; neither path may create evidence or be described as preventing preloads, because caller preload code could run before their JavaScript checks. Caller-set environment alone cannot satisfy the launcher's challenge, which is defense in depth rather than a general authorization secret. Git uses its separately approved absolute executable and minimal environment. All source/test and ledger reads bind the opened handle identity to the contemporaneous canonical allowlisted path before and after open/read, rejecting final-file or ancestor swaps before any bytes are returned for hashing; evidence storage remains reparse-free and contained. A behavior cannot be marked TDD-complete without its observed relevant red followed by that final green. The final test report also records discovered/loaded test files, expanded cases, pass/fail/skip/todo, and new versus modified test files/cases.

Final verification runs in this order:

1. npm run typecheck
2. npm run lint
3. npm test
4. npm run build
5. npm run release:rc -- --freeze
6. npm run release:manual-evidence -- --freeze release-validation/candidate-freeze.json --report release-validation/manual-release-evidence.json --allow-system-mutation
7. npm run release:rc -- --resume --manual-evidence release-validation/manual-release-evidence.json --allow-system-mutation
8. npm run release:verify -- --check-only --no-write

The release:rc evidence exposes the individual results for release:preflight, release:build:win, release:signing-check, release:verify-signature, release:sbom, release:manifest, release:verify, artifact checksums, frozen manual evidence, and release:acceptance in the dependency-safe internal order defined above. Each public command remains directly runnable for diagnosis, but only a matching release:rc resume may emit the final gate report.

Production acceptance uses real packaged Main, Preload, Renderer, SQLite, safeStorage, Diagnostics, Crash Recovery, UpdateManager, electron-builder, and NSIS. Fake model transport is allowed, and no paid model call is required.

Acceptance records each scenario and assertion as PASS, FAIL, BLOCKED, NOT_RUN, or NEEDS_MANUAL_EVIDENCE with command/evidence/hash/blocker fields. FAIL means an executed assertion produced a negative result; BLOCKED means a prerequisite or authorized environment was unavailable; both fail a closed-Beta-required item. It freezes both the exact sixty automated Task 15 assertions and the exact forty-four production A1–F7 scenario items; an aggregate PASS cannot replace any item. It covers clean install, isolated user data, first run, About metadata, renderer errors, persisted test provider/credential/history/template/settings/checkpoint data, restart, installer-over-install upgrade, local-feed discovery/download/failure and controlled fixture update, migration/backup, diagnostics scan, default-preserving uninstall, shortcuts/icons, Chinese/space paths, Win10 x64, Win11 x64, 125%/150% scaling, package composition, signature status, hashes, size, startup/About/update/diagnostics timings, and residual Electron/Node/Claude/MCP processes.

Credential retention is proven by successful use through its opaque reference while plaintext and reference values remain unavailable to Renderer. Upgrade evidence separately proves First Run does not repeat, checkpoints/templates/settings/history remain, update logs are redacted, and no test-owned old process remains. Hash-mismatch failure also proves the database is unchanged, the application remains usable, and diagnostics remain exportable.

Generated evidence is ignored and references artifacts by relative display name plus hash. If a destructive or GUI closed-Beta acceptance step cannot be safely automated, the report uses NEEDS_MANUAL_EVIDENCE, lists the exact missing evidence, and sets closedBetaReady=false. Real NSIS install/start/uninstall, installer-over-install upgrade, production Electron, shortcuts/icons, Chinese/space-path checks, Win10 x64, Win11 x64, and 125%/150% scaling require attached, hash-bound evidence before a pass. The separately hash-bound manual diagnostic-ZIP review is a GA-only blocker and cannot be used to waive the automated diagnostic allowlist/sentinel checks.

The full-suite report proves every discovered test file loaded, records file/case/pass/fail/skip/todo counts, and fails if a skip or todo masks a required release assertion. Residual-process checks track only test-owned PIDs plus process creation times, including spawned Electron, Node, Claude, and MCP descendants, so unrelated user processes are neither counted nor terminated.

The performance/package report records installer and unpacked exact-byte size. The compressed installer is reported only as a total size/hash; it is not falsely mapped one-for-one to unpacked categories. Every file in the canonical unpacked tree is classified and reconciled to 100% of that tree, including Electron, Monaco, better-sqlite3, Agent SDK, source maps, tests, and other resources. It binds every measurement to commit, Build ID, artifact hash, architecture, Windows build, and a sanitized test-profile label.

Timing protocol distinguishes two explicitly bound executables. The final installed RC1 measures fresh-profile startup, warm restart, About click to content-ready, its fail-closed unconfigured update control, and diagnostics request to final ZIP close against a fixed synthetic dataset. The separately installed, non-releasable RC0 fixture measures loopback update request to terminal result and records both its own fixture artifact hash and the target RC1 installer hash; that result is never described as an RC1 local-feed capability. Startup uses three fresh profiles plus five warm restarts; About and each update-control measurement use one warm-up plus five samples; diagnostics uses three samples. Reports include every sample and median/min/max, never call filesystem-cache behavior “cold” unless the harness actually controls it, and present results as environment-specific observations.

## 17. Gate calculation and failure semantics

Gate state is orthogonal, not one mutually exclusive enum:

    {
      closedBetaReady: boolean,
      publicGaReady: false,
      distributionExecuted: false,
      statuses: ["PASS_FOR_CLOSED_BETA", "BLOCKED_FOR_PUBLIC_GA"],
      closedBetaBlockers: [],
      publicGaBlockers: []
    }

When closedBetaReady is false, PASS_FOR_CLOSED_BETA is omitted and PASS_FOR_INTERNAL_DEVELOPMENT remains. BLOCKED_FOR_PUBLIC_GA remains present in every Task 15 result. In this owner-defined Task, PASS_FOR_CLOSED_BETA is a technical/operational candidate-readiness label, exactly as specified in the source requirements; it is not a software-license grant, legal opinion, trademark clearance, production publication, or evidence that distribution occurred. The pipeline never distributes anything. Any actual cohort invitation/distribution remains a separate project-owner action subject to the draft Beta terms/privacy disclosures and the recorded unresolved legal identity/contact decisions. The icon attestation cannot authorize that separate action.

PASS_FOR_CLOSED_BETA requires a clean committed 1.0.1-rc.1 build, exact task15 branch, consistent metadata/release notes, a real NSIS installer, all exact sixty automated assertions and forty-four production A1–F7 items, completed install/start/uninstall/upgrade and required Win10/Win11/DPI evidence, data preservation, successful isolated local-feed schema/discovery/download/hash/failure acceptance, an explicit separate blocker for the untrusted historical 1.0.0 updater chain, complete asset provenance/parity/package/manual-review evidence, Manifest/inner artifact ledger/verified outer delivery ledger, SBOM/notices and required dependency-license approvals, diagnostic sentinel pass, Beta/legal drafts, production Electron acceptance, zero renderer errors, zero test-owned residual processes, no closed-Beta NEEDS_MANUAL_EVIDENCE item, no unresolved P0 or P1 finding of any category, and unchanged stable main. Every unresolved P0/P1 sets closedBetaReady=false; data integrity, credential/diagnostic secrecy, arbitrary code execution, authorization, privacy, process containment, update integrity, installation, and recovery are non-exhaustive examples.

The task remains BLOCKED_FOR_PUBLIC_GA while any required GA item is absent, including trusted signing, production feed, final license/privacy, legal publishing identity/contact, final name/trademark decision, external test completion, trustworthy historical upgrade evidence, unresolved P0/P1 data-loss or permission issue, or manual diagnostic review.

Failures are structured, safe, and non-zero where appropriate. A failed release stage never leaves a success marker. A failed feed leaves the application usable. A failed hash/signature/backup blocks installation. A failed migration preserves original and backup. An absent feedback URL leaves local feedback available. Missing signing material is truthfully NotSigned, not a crash and not Signed.

## 18. Git and delivery

The implementation is maintained as one final task15 changeset with commit message:

    chore(release): prepare controlled beta candidate

The design checkpoint may be amended so the final branch contains the required message and complete source/test/documentation changes. Before final commit verification, run git diff --check, git status --short, git diff --stat, credential scan, artifact scan, and an independent review.

No tag is created. The final report may recommend a future tag only after merge and owner approval. Nothing is pushed or merged, and the stable main worktree must still resolve to the audited baseline with a clean tracked status.

The final handoff has both Markdown and final-report.json forms. Every item uses the schema id, status (PASS, FAIL, BLOCKED, NOT_RUN, NEEDS_MANUAL_EVIDENCE, or INFORMATIONAL), evidence entries with relative path/command/SHA-256 where applicable, and blockerReason. FAIL retains the executed-negative-result meaning above; INFORMATIONAL can never satisfy a required gate. Its fixed 1–40 mapping is:

1. release capability audit matrix;
2. reused pre-existing release capabilities;
3. capabilities added in Task 15;
4. target version and selection rationale;
5. release channel;
6. ReleaseMetadata architecture;
7. Build ID and commit injection;
8. release preflight;
9. installer configuration;
10. installer relative path, size, and SHA-256;
11. signature status;
12. unsigned-user warning;
13. updater architecture;
14. local-update acceptance;
15. upgrade data-retention result;
16. database migration/backup result;
17. Release Manifest and checksums;
18. SBOM;
19. third-party notices;
20. project-license status;
21. privacy-draft status;
22. affiliation/brand/asset audit;
23. diagnostics redaction/sentinel result;
24. Beta Feedback experience;
25. install, upgrade, and uninstall acceptance;
26. performance and package-composition measurements;
27. added/modified file inventory;
28. added/expanded test counts;
29. full test file/case/pass/fail/skip/todo counts;
30. typecheck, lint, test, and build results;
31. every release-command result;
32. renderer error count;
33. test-owned residual-process count;
34. closedBetaReady and PASS_FOR_CLOSED_BETA decision;
35. publicGaReady=false and BLOCKED_FOR_PUBLIC_GA reasons;
36. final task15 commit SHA;
37. stable-main SHA and clean tracked status;
38. unresolved issues;
39. future post-merge tag recommendation, explicitly not created;
40. next-stage recommendations.
