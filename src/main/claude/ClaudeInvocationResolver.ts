import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export type ClaudeInvocationFailureReason =
  "not_installed" | "unsupported_installation";

export interface ResolvedClaudeInvocation {
  readonly executable: string;
  readonly prefixArgs: readonly string[];
  readonly environmentPatch: Readonly<Record<string, string>>;
  readonly displayPath: string;
  readonly canonicalTargetPath: string;
  readonly provenance: "native" | "npm";
}

export type ClaudeInvocationResolution =
  | { readonly ok: true; readonly invocation: ResolvedClaudeInvocation }
  | { readonly ok: false; readonly reason: ClaudeInvocationFailureReason };

export interface ClaudeInvocationResolverPort {
  resolve(): ClaudeInvocationResolution;
}

interface ClaudeInvocationFileFacts {
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

interface ClaudeInvocationFilesystem {
  realpath(filePath: string): string;
  lstat(filePath: string): ClaudeInvocationFileFacts;
  readdir(directory: string): readonly string[];
}

export interface ClaudeInvocationResolverOptions {
  readonly platform?: NodeJS.Platform;
  readonly environment?: Readonly<NodeJS.ProcessEnv>;
  readonly electronExecutable?: string;
  readonly untrustedRoots?: readonly string[];
  readonly locate?: () => readonly string[];
  readonly filesystem?: ClaudeInvocationFilesystem;
}

interface FileObservation {
  readonly canonicalPath: string;
  readonly facts: Readonly<{
    dev: number;
    ino: number;
    size: number;
    mtimeMs: number;
    file: boolean;
    symbolicLink: boolean;
  }>;
}

type FileObservationAttempt =
  | { readonly kind: "observed"; readonly observation: FileObservation }
  | { readonly kind: "missing" }
  | { readonly kind: "unsupported" };

type CandidateAttempt =
  | { readonly kind: "resolved"; readonly invocation: ResolvedClaudeInvocation }
  | { readonly kind: "missing" }
  | { readonly kind: "unsupported" };

const NOT_INSTALLED = Object.freeze({
  ok: false as const,
  reason: "not_installed" as const,
});
const UNSUPPORTED_INSTALLATION = Object.freeze({
  ok: false as const,
  reason: "unsupported_installation" as const,
});
const EMPTY_ENVIRONMENT_PATCH = Object.freeze({}) as Readonly<
  Record<string, string>
>;
const NPM_ENVIRONMENT_PATCH = Object.freeze({
  ELECTRON_RUN_AS_NODE: "1",
}) as Readonly<Record<string, string>>;

const DEFAULT_FILESYSTEM: ClaudeInvocationFilesystem = Object.freeze({
  realpath: (filePath: string) => fs.realpathSync.native(filePath),
  lstat: (filePath: string) => fs.lstatSync(filePath),
  readdir: (directory: string) => fs.readdirSync(directory),
});

function defaultLocate(platform: NodeJS.Platform): readonly string[] {
  try {
    const output = execFileSync(
      platform === "win32" ? "where" : "which",
      ["claude"],
      {
        encoding: "utf8",
        timeout: 5_000,
        windowsHide: true,
        shell: false,
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    return output
      .split(/\r?\n/u)
      .map((candidate) => candidate.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function sameFileFacts(
  left: FileObservation["facts"],
  right: FileObservation["facts"],
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.file === right.file &&
    left.symbolicLink === right.symbolicLink
  );
}

function isMissingFilesystemError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "ENOENT"
  );
}

function environmentEntries(
  environment: Readonly<Record<string, string>>,
): readonly string[] {
  return Object.entries(environment)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}\u0000${value}`);
}

function sameStringArray(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

export function sameClaudeInvocationIdentity(
  left: ResolvedClaudeInvocation,
  right: ResolvedClaudeInvocation,
): boolean {
  return (
    left.executable === right.executable &&
    sameStringArray(left.prefixArgs, right.prefixArgs) &&
    sameStringArray(
      environmentEntries(left.environmentPatch),
      environmentEntries(right.environmentPatch),
    ) &&
    left.canonicalTargetPath === right.canonicalTargetPath &&
    left.provenance === right.provenance
  );
}

export function mergeClaudeInvocationEnvironment(
  environment: Readonly<NodeJS.ProcessEnv>,
  invocation: ResolvedClaudeInvocation,
): Readonly<NodeJS.ProcessEnv> {
  return Object.freeze({
    ...environment,
    ...invocation.environmentPatch,
  });
}

export class ClaudeInvocationResolver implements ClaudeInvocationResolverPort {
  private readonly platform: NodeJS.Platform;
  private readonly environment: Readonly<NodeJS.ProcessEnv>;
  private readonly electronExecutable: string;
  private readonly untrustedRoots: readonly string[];
  private readonly locate: () => readonly string[];
  private readonly filesystem: ClaudeInvocationFilesystem;
  private readonly pathApi: typeof path.win32 | typeof path.posix;

  constructor(options: ClaudeInvocationResolverOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.environment = options.environment ?? process.env;
    this.electronExecutable = options.electronExecutable ?? process.execPath;
    this.untrustedRoots = Object.freeze([...(options.untrustedRoots ?? [])]);
    this.locate = options.locate ?? (() => defaultLocate(this.platform));
    this.filesystem = options.filesystem ?? DEFAULT_FILESYSTEM;
    this.pathApi = this.platform === "win32" ? path.win32 : path.posix;
  }

  resolve(): ClaudeInvocationResolution {
    let located: readonly string[];
    try {
      located = this.locate();
    } catch {
      located = [];
    }

    const firstCandidate = located
      .map((candidate) => candidate.trim())
      .find(Boolean);
    if (firstCandidate) {
      const attempt = this.resolveCandidate(firstCandidate);
      if (attempt.kind === "resolved") return this.success(attempt.invocation);
      return UNSUPPORTED_INSTALLATION;
    }

    if (this.platform !== "win32") return NOT_INSTALLED;
    for (const fallback of this.windowsFallbacks()) {
      const attempt = this.resolveCandidate(fallback);
      if (attempt.kind === "resolved") return this.success(attempt.invocation);
      if (attempt.kind === "unsupported") return UNSUPPORTED_INSTALLATION;
    }
    return NOT_INSTALLED;
  }

  private windowsFallbacks(): readonly string[] {
    const candidates: string[] = [];
    if (this.environment.LOCALAPPDATA) {
      candidates.push(
        this.pathApi.join(
          this.environment.LOCALAPPDATA,
          "Programs",
          "claude",
          "claude.exe",
        ),
      );
    }
    if (this.environment.USERPROFILE) {
      candidates.push(
        this.pathApi.join(
          this.environment.USERPROFILE,
          ".local",
          "bin",
          "claude.exe",
        ),
      );
    }
    if (this.environment.APPDATA) {
      candidates.push(
        this.pathApi.join(this.environment.APPDATA, "npm", "claude.cmd"),
      );
    }
    return candidates;
  }

  private resolveCandidate(displayPath: string): CandidateAttempt {
    if (!this.isSafeAbsolutePath(displayPath)) return { kind: "unsupported" };

    const normalizedDisplayPath = this.pathApi.normalize(displayPath);
    if (this.platform !== "win32") {
      return this.resolveNative(normalizedDisplayPath);
    }

    const extension = this.pathApi
      .extname(normalizedDisplayPath)
      .toLocaleLowerCase("en-US");
    const basename = this.pathApi
      .basename(normalizedDisplayPath, extension)
      .toLocaleLowerCase("en-US");
    if (basename !== "claude") return { kind: "unsupported" };
    if (extension === ".exe" || extension === ".com") {
      return this.resolveNative(normalizedDisplayPath);
    }
    if (extension === ".cmd" || extension === ".ps1") {
      return this.resolveNpm(normalizedDisplayPath);
    }
    return { kind: "unsupported" };
  }

  private resolveNative(displayPath: string): CandidateAttempt {
    const observed = this.observeOrdinaryFile(displayPath);
    if (observed.kind !== "observed") return observed;
    const { observation } = observed;
    if (!this.isCanonicalCase(observation.canonicalPath))
      return { kind: "unsupported" };
    if (this.isForbidden(displayPath, displayPath, observation.canonicalPath)) {
      return { kind: "unsupported" };
    }

    return {
      kind: "resolved",
      invocation: this.freezeInvocation({
        executable: observation.canonicalPath,
        prefixArgs: [],
        environmentPatch: EMPTY_ENVIRONMENT_PATCH,
        displayPath,
        canonicalTargetPath: observation.canonicalPath,
        provenance: "native",
      }),
    };
  }

  private resolveNpm(displayPath: string): CandidateAttempt {
    const packageRoot = this.pathApi.join(
      this.pathApi.dirname(displayPath),
      "node_modules",
      "@anthropic-ai",
      "claude-code",
    );
    const cliPath = this.pathApi.join(packageRoot, "cli.js");
    const observed = this.observeOrdinaryFile(cliPath);
    if (observed.kind !== "observed") return observed;
    const { observation } = observed;

    const canonicalPackageRoot = this.observeStableRealpath(packageRoot);
    if (
      !canonicalPackageRoot ||
      !this.isCanonicalCase(observation.canonicalPath) ||
      !this.isExactOrDescendant(
        canonicalPackageRoot,
        observation.canonicalPath,
      ) ||
      this.isForbidden(displayPath, cliPath, observation.canonicalPath)
    ) {
      return { kind: "unsupported" };
    }

    return {
      kind: "resolved",
      invocation: this.freezeInvocation({
        executable: this.electronExecutable,
        prefixArgs: [observation.canonicalPath],
        environmentPatch: NPM_ENVIRONMENT_PATCH,
        displayPath,
        canonicalTargetPath: observation.canonicalPath,
        provenance: "npm",
      }),
    };
  }

  private observeOrdinaryFile(filePath: string): FileObservationAttempt {
    try {
      const firstFacts = this.readFileFacts(filePath);
      const firstRealpath = this.filesystem.realpath(filePath);
      const secondFacts = this.readFileFacts(filePath);
      const secondRealpath = this.filesystem.realpath(filePath);
      if (
        !firstFacts.file ||
        firstFacts.symbolicLink ||
        !secondFacts.file ||
        secondFacts.symbolicLink ||
        !sameFileFacts(firstFacts, secondFacts) ||
        firstRealpath !== secondRealpath ||
        !this.isSafeAbsolutePath(firstRealpath)
      ) {
        return { kind: "unsupported" };
      }
      return {
        kind: "observed",
        observation: Object.freeze({
          canonicalPath: this.pathApi.normalize(firstRealpath),
          facts: firstFacts,
        }),
      };
    } catch (error) {
      return {
        kind: isMissingFilesystemError(error) ? "missing" : "unsupported",
      };
    }
  }

  private readFileFacts(filePath: string): FileObservation["facts"] {
    const facts = this.filesystem.lstat(filePath);
    return Object.freeze({
      dev: facts.dev,
      ino: facts.ino,
      size: facts.size,
      mtimeMs: facts.mtimeMs,
      file: facts.isFile(),
      symbolicLink: facts.isSymbolicLink(),
    });
  }

  private observeStableRealpath(filePath: string): string | null {
    try {
      const first = this.filesystem.realpath(filePath);
      const second = this.filesystem.realpath(filePath);
      if (first !== second || !this.isSafeAbsolutePath(first)) return null;
      return this.pathApi.normalize(first);
    } catch {
      return null;
    }
  }

  private isCanonicalCase(filePath: string): boolean {
    try {
      const normalized = this.pathApi.normalize(filePath);
      const parsed = this.pathApi.parse(normalized);
      let directory = parsed.root;
      const relative = normalized.slice(parsed.root.length);
      const segments = relative.split(this.pathApi.sep).filter(Boolean);
      for (const segment of segments) {
        const entries = this.filesystem.readdir(directory);
        const matches =
          this.platform === "win32"
            ? entries.filter(
                (entry) =>
                  entry.toLocaleLowerCase("en-US") ===
                  segment.toLocaleLowerCase("en-US"),
              )
            : entries.filter((entry) => entry === segment);
        if (matches.length !== 1 || matches[0] !== segment) return false;
        directory = this.pathApi.join(directory, segment);
      }
      return segments.length > 0;
    } catch {
      return false;
    }
  }

  private isForbidden(
    displayPath: string,
    lexicalTargetPath: string,
    canonicalTargetPath: string,
  ): boolean {
    for (const configuredRoot of this.untrustedRoots) {
      if (!this.isSafeAbsolutePath(configuredRoot)) return true;
      const lexicalRoot = this.pathApi.normalize(configuredRoot);
      const canonicalRoot = this.observeStableRealpath(lexicalRoot);
      if (!canonicalRoot) return true;
      const candidates = [displayPath, lexicalTargetPath, canonicalTargetPath];
      if (
        candidates.some((candidate) =>
          this.isExactOrDescendant(lexicalRoot, candidate),
        ) ||
        candidates.some((candidate) =>
          this.isExactOrDescendant(canonicalRoot, candidate),
        )
      ) {
        return true;
      }
    }
    return false;
  }

  private isExactOrDescendant(root: string, candidate: string): boolean {
    const relative = this.pathApi.relative(root, candidate);
    return (
      relative === "" ||
      (relative !== ".." &&
        !relative.startsWith(`..${this.pathApi.sep}`) &&
        !this.pathApi.isAbsolute(relative))
    );
  }

  private isSafeAbsolutePath(filePath: string): boolean {
    return (
      Boolean(filePath) &&
      !filePath.includes("\0") &&
      this.pathApi.isAbsolute(filePath)
    );
  }

  private freezeInvocation(
    invocation: ResolvedClaudeInvocation,
  ): ResolvedClaudeInvocation {
    return Object.freeze({
      ...invocation,
      prefixArgs: Object.freeze([...invocation.prefixArgs]),
      environmentPatch: Object.freeze({ ...invocation.environmentPatch }),
    });
  }

  private success(
    invocation: ResolvedClaudeInvocation,
  ): ClaudeInvocationResolution {
    return Object.freeze({ ok: true, invocation });
  }
}
