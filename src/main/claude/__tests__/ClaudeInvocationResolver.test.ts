import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ClaudeInvocationResolver,
  mergeClaudeInvocationEnvironment,
  sameClaudeInvocationIdentity,
  type ClaudeInvocationResolverOptions,
  type ResolvedClaudeInvocation,
} from "../ClaudeInvocationResolver";

interface FileFacts {
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly file: boolean;
  readonly symbolicLink: boolean;
}

interface HarnessOptions {
  readonly platform?: NodeJS.Platform;
  readonly located?: readonly string[];
  readonly environment?: Readonly<NodeJS.ProcessEnv>;
  readonly electronExecutable?: string;
  readonly untrustedRoots?: readonly string[];
  readonly files?: Readonly<Record<string, FileFacts | readonly FileFacts[]>>;
  readonly realpaths?: Readonly<Record<string, string | readonly string[]>>;
  readonly directoryEntries?: Readonly<Record<string, readonly string[]>>;
}

function ordinaryFile(overrides: Partial<FileFacts> = {}): FileFacts {
  return {
    dev: 1,
    ino: 1,
    size: 1024,
    mtimeMs: 100,
    file: true,
    symbolicLink: false,
    ...overrides,
  };
}

function resolverHarness(options: HarnessOptions = {}) {
  const platform = options.platform ?? "win32";
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const keyOf = (value: string) => {
    const normalized = pathApi.normalize(value);
    return platform === "win32"
      ? normalized.toLocaleLowerCase("en-US")
      : normalized;
  };
  const files = new Map(
    Object.entries(options.files ?? {}).map(([filePath, facts]) => [
      keyOf(filePath),
      { canonicalPath: pathApi.normalize(filePath), facts },
    ]),
  );
  const realpaths = new Map(
    Object.entries(options.realpaths ?? {}).map(([filePath, targets]) => [
      keyOf(filePath),
      typeof targets === "string" ? [targets] : [...targets],
    ]),
  );
  const directoryEntries = new Map(
    Object.entries(options.directoryEntries ?? {}).map(
      ([directory, entries]) => [keyOf(directory), [...entries]],
    ),
  );
  const realpathCalls = new Map<string, number>();
  const lstatCalls = new Map<string, number>();
  const touched = {
    realpath: [] as string[],
    lstat: [] as string[],
    readdir: [] as string[],
  };

  const knownCanonicalPaths = (): string[] =>
    [
      ...[...files.values()].map((entry) => entry.canonicalPath),
      ...[...realpaths.values()].flat(),
    ].map((entry) => pathApi.normalize(entry));

  const filesystem: NonNullable<ClaudeInvocationResolverOptions["filesystem"]> =
    {
      realpath(filePath) {
        touched.realpath.push(filePath);
        const key = keyOf(filePath);
        const sequence = realpaths.get(key);
        if (sequence) {
          const call = realpathCalls.get(key) ?? 0;
          realpathCalls.set(key, call + 1);
          return pathApi.normalize(
            sequence[Math.min(call, sequence.length - 1)],
          );
        }
        const file = files.get(key);
        if (file) return file.canonicalPath;
        return pathApi.normalize(filePath);
      },
      lstat(filePath) {
        touched.lstat.push(filePath);
        const key = keyOf(filePath);
        const entry = files.get(key);
        if (!entry)
          throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        const call = lstatCalls.get(key) ?? 0;
        lstatCalls.set(key, call + 1);
        const sequence = Array.isArray(entry.facts)
          ? entry.facts
          : [entry.facts];
        const facts = sequence[Math.min(call, sequence.length - 1)];
        return {
          dev: facts.dev,
          ino: facts.ino,
          size: facts.size,
          mtimeMs: facts.mtimeMs,
          isFile: () => facts.file,
          isSymbolicLink: () => facts.symbolicLink,
        };
      },
      readdir(directory) {
        touched.readdir.push(directory);
        const configured = directoryEntries.get(keyOf(directory));
        if (configured) return configured;

        const entries = new Set<string>();
        for (const candidate of knownCanonicalPaths()) {
          const relative = pathApi.relative(
            pathApi.normalize(directory),
            candidate,
          );
          if (
            !relative ||
            relative === ".." ||
            relative.startsWith(`..${pathApi.sep}`) ||
            pathApi.isAbsolute(relative)
          ) {
            continue;
          }
          entries.add(relative.split(pathApi.sep)[0]);
        }
        return [...entries];
      },
    };

  let locateCalls = 0;
  const resolver = new ClaudeInvocationResolver({
    platform,
    environment: options.environment ?? {},
    electronExecutable:
      options.electronExecutable ?? "C:\\Workbench\\electron.exe",
    untrustedRoots: options.untrustedRoots,
    locate: () => {
      locateCalls += 1;
      return options.located ?? [];
    },
    filesystem,
  });

  return {
    resolver,
    touched,
    locateCalls: () => locateCalls,
  };
}

function baseInvocation(): ResolvedClaudeInvocation {
  return Object.freeze({
    executable: "C:\\Workbench\\electron.exe",
    prefixArgs: Object.freeze([
      "C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js",
    ]),
    environmentPatch: Object.freeze({ ELECTRON_RUN_AS_NODE: "1" }),
    displayPath: "C:\\npm\\claude.cmd",
    canonicalTargetPath:
      "C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js",
    provenance: "npm" as const,
  });
}

describe("ClaudeInvocationResolver", () => {
  it("resolves the first native binary to a canonical shell-free invocation", () => {
    const test = resolverHarness({
      located: ["C:\\native\\claude.exe"],
      environment: { SECRET: "not-an-invocation-setting" },
      files: { "C:\\native\\claude.exe": ordinaryFile() },
    });

    expect(test.resolver.resolve()).toEqual({
      ok: true,
      invocation: {
        executable: "C:\\native\\claude.exe",
        prefixArgs: [],
        environmentPatch: {},
        displayPath: "C:\\native\\claude.exe",
        canonicalTargetPath: "C:\\native\\claude.exe",
        provenance: "native",
      },
    });
    expect(test.locateCalls()).toBe(1);
  });

  it("runs an npm target through Electron-as-Node without executing its cmd shim", () => {
    const cli = "C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js";
    const test = resolverHarness({
      located: ["C:\\npm\\claude.cmd"],
      files: { [cli]: ordinaryFile() },
    });

    expect(test.resolver.resolve()).toEqual({
      ok: true,
      invocation: {
        executable: "C:\\Workbench\\electron.exe",
        prefixArgs: [cli],
        environmentPatch: { ELECTRON_RUN_AS_NODE: "1" },
        displayPath: "C:\\npm\\claude.cmd",
        canonicalTargetPath: cli,
        provenance: "npm",
      },
    });
    expect(test.touched.lstat).not.toContain("C:\\npm\\claude.cmd");
  });

  it("does not let a later native binary overtake the first npm shim", () => {
    const cli = "C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js";
    const test = resolverHarness({
      located: ["C:\\npm\\claude.cmd", "C:\\native\\claude.exe"],
      files: {
        [cli]: ordinaryFile(),
        "C:\\native\\claude.exe": ordinaryFile(),
      },
    });

    expect(test.resolver.resolve()).toEqual({
      ok: true,
      invocation: expect.objectContaining({
        provenance: "npm",
        canonicalTargetPath: cli,
        prefixArgs: [cli],
        environmentPatch: { ELECTRON_RUN_AS_NODE: "1" },
      }),
    });
    expect(test.touched.lstat).not.toContain("C:\\native\\claude.exe");
  });

  it("does not let a later npm shim overtake the first native binary", () => {
    const cli = "C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js";
    const test = resolverHarness({
      located: ["C:\\native\\claude.exe", "C:\\npm\\claude.cmd"],
      files: {
        "C:\\native\\claude.exe": ordinaryFile(),
        [cli]: ordinaryFile(),
      },
    });

    expect(test.resolver.resolve()).toEqual({
      ok: true,
      invocation: expect.objectContaining({
        provenance: "native",
        canonicalTargetPath: "C:\\native\\claude.exe",
      }),
    });
    expect(test.touched.lstat).not.toContain(cli);
  });

  it("fails closed on an invalid first locator candidate without inspecting a later install", () => {
    const test = resolverHarness({
      located: ["C:\\broken\\claude.exe", "C:\\native\\claude.exe"],
      files: { "C:\\native\\claude.exe": ordinaryFile() },
    });

    expect(test.resolver.resolve()).toEqual({
      ok: false,
      reason: "unsupported_installation",
    });
    expect(test.touched.lstat).not.toContain("C:\\native\\claude.exe");
  });

  it("accepts duplicate locator lines for the same canonical target", () => {
    const test = resolverHarness({
      located: ["C:\\native\\claude.exe", "C:\\native\\claude.exe"],
      files: { "C:\\native\\claude.exe": ordinaryFile() },
    });

    expect(test.resolver.resolve()).toEqual({
      ok: true,
      invocation: expect.objectContaining({
        canonicalTargetPath: "C:\\native\\claude.exe",
      }),
    });
  });

  it("uses fixed fallbacks only when the locator is empty and preserves fallback order", () => {
    const npmCli =
      "C:\\Users\\Ada\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js";
    const test = resolverHarness({
      located: [],
      environment: {
        LOCALAPPDATA: "C:\\Users\\Ada\\AppData\\Local",
        USERPROFILE: "C:\\Users\\Ada",
        APPDATA: "C:\\Users\\Ada\\AppData\\Roaming",
      },
      files: {
        "C:\\Users\\Ada\\.local\\bin\\claude.exe": ordinaryFile(),
        [npmCli]: ordinaryFile(),
      },
    });

    expect(test.resolver.resolve()).toEqual({
      ok: true,
      invocation: expect.objectContaining({
        canonicalTargetPath: "C:\\Users\\Ada\\.local\\bin\\claude.exe",
        provenance: "native",
      }),
    });
    expect(test.touched.lstat).not.toContain(npmCli);
  });

  it("uses the fixed npm fallback after absent native fallbacks", () => {
    const cli =
      "C:\\Users\\Ada\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js";
    const test = resolverHarness({
      located: [],
      environment: {
        LOCALAPPDATA: "C:\\Users\\Ada\\AppData\\Local",
        USERPROFILE: "C:\\Users\\Ada",
        APPDATA: "C:\\Users\\Ada\\AppData\\Roaming",
      },
      files: { [cli]: ordinaryFile() },
    });

    expect(test.resolver.resolve()).toEqual({
      ok: true,
      invocation: expect.objectContaining({
        executable: "C:\\Workbench\\electron.exe",
        canonicalTargetPath: cli,
        provenance: "npm",
      }),
    });
  });

  it("fails closed when the first existing fallback is not an ordinary file", () => {
    const test = resolverHarness({
      located: [],
      environment: {
        LOCALAPPDATA: "C:\\Users\\Ada\\AppData\\Local",
        USERPROFILE: "C:\\Users\\Ada",
      },
      files: {
        "C:\\Users\\Ada\\AppData\\Local\\Programs\\claude\\claude.exe":
          ordinaryFile({ symbolicLink: true }),
        "C:\\Users\\Ada\\.local\\bin\\claude.exe": ordinaryFile(),
      },
    });

    expect(test.resolver.resolve()).toEqual({
      ok: false,
      reason: "unsupported_installation",
    });
    expect(test.touched.lstat).not.toContain(
      "C:\\Users\\Ada\\.local\\bin\\claude.exe",
    );
  });

  it("reports not installed when neither the locator nor fixed fallbacks exist", () => {
    const test = resolverHarness({
      located: [],
      environment: {
        LOCALAPPDATA: "C:\\Users\\Ada\\AppData\\Local",
        USERPROFILE: "C:\\Users\\Ada",
        APPDATA: "C:\\Users\\Ada\\AppData\\Roaming",
      },
    });

    expect(test.resolver.resolve()).toEqual({
      ok: false,
      reason: "not_installed",
    });
  });

  it.each([
    ["symbolic link", ordinaryFile({ symbolicLink: true })],
    ["directory", ordinaryFile({ file: false })],
  ])(
    "rejects a selected target that is a %s rather than an ordinary file",
    (_label, facts) => {
      const test = resolverHarness({
        located: ["C:\\native\\claude.exe"],
        files: { "C:\\native\\claude.exe": facts },
      });

      expect(test.resolver.resolve()).toEqual({
        ok: false,
        reason: "unsupported_installation",
      });
    },
  );

  it("rejects a case-fold collision in the canonical target directory", () => {
    const test = resolverHarness({
      located: ["C:\\native\\claude.exe"],
      files: { "C:\\native\\claude.exe": ordinaryFile() },
      directoryEntries: {
        "C:\\native": ["claude.exe", "CLAUDE.EXE"],
      },
    });

    expect(test.resolver.resolve()).toEqual({
      ok: false,
      reason: "unsupported_installation",
    });
  });

  it("rejects a target whose reported path does not use its canonical case", () => {
    const test = resolverHarness({
      located: ["C:\\native\\claude.exe"],
      files: { "C:\\native\\Claude.exe": ordinaryFile() },
      realpaths: {
        "C:\\native\\claude.exe": "C:\\native\\claude.exe",
      },
    });

    expect(test.resolver.resolve()).toEqual({
      ok: false,
      reason: "unsupported_installation",
    });
  });

  it("rejects a target whose realpath changes between observations", () => {
    const first = "C:\\native\\claude.exe";
    const second = "C:\\redirected\\claude.exe";
    const test = resolverHarness({
      located: [first],
      files: { [first]: ordinaryFile() },
      realpaths: { [first]: [first, second] },
    });

    expect(test.resolver.resolve()).toEqual({
      ok: false,
      reason: "unsupported_installation",
    });
  });

  it("rejects a target whose file identity changes between observations", () => {
    const target = "C:\\native\\claude.exe";
    const test = resolverHarness({
      located: [target],
      files: {
        [target]: [ordinaryFile({ ino: 1 }), ordinaryFile({ ino: 2 })],
      },
    });

    expect(test.resolver.resolve()).toEqual({
      ok: false,
      reason: "unsupported_installation",
    });
  });

  it("rejects an npm cli target that escapes its canonical package root", () => {
    const cli = "C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js";
    const test = resolverHarness({
      located: ["C:\\npm\\claude.cmd"],
      files: { [cli]: ordinaryFile() },
      realpaths: { [cli]: "C:\\outside\\cli.js" },
    });

    expect(test.resolver.resolve()).toEqual({
      ok: false,
      reason: "unsupported_installation",
    });
  });

  it("rejects canonical targets beneath an explicitly supplied forbidden root", () => {
    const target = "C:\\repo\\tools\\claude.exe";
    const test = resolverHarness({
      located: [target],
      untrustedRoots: ["C:\\repo"],
      files: { [target]: ordinaryFile() },
    });

    expect(test.resolver.resolve()).toEqual({
      ok: false,
      reason: "unsupported_installation",
    });
  });

  it("does not implicitly treat the current directory as a forbidden root", () => {
    const target = "C:\\repo\\tools\\claude.exe";
    const test = resolverHarness({
      located: [target],
      files: { [target]: ordinaryFile() },
    });

    expect(test.resolver.resolve()).toEqual({
      ok: true,
      invocation: expect.objectContaining({ canonicalTargetPath: target }),
    });
  });

  it("freezes every returned result, invocation, prefix, and environment object", () => {
    const success = resolverHarness({
      located: ["C:\\npm\\claude.cmd"],
      files: {
        "C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js":
          ordinaryFile(),
      },
    }).resolver.resolve();
    const failure = resolverHarness().resolver.resolve();

    expect(Object.isFrozen(success)).toBe(true);
    expect(Object.isFrozen(failure)).toBe(true);
    expect(success.ok).toBe(true);
    if (success.ok) {
      expect(Object.isFrozen(success.invocation)).toBe(true);
      expect(Object.isFrozen(success.invocation.prefixArgs)).toBe(true);
      expect(Object.isFrozen(success.invocation.environmentPatch)).toBe(true);
    }
  });

  it("supports an ordinary non-Windows locator target without npm environment settings", () => {
    const target = "/opt/claude/bin/claude";
    const test = resolverHarness({
      platform: "linux",
      located: [target],
      electronExecutable: "/opt/workbench/electron",
      files: { [target]: ordinaryFile() },
    });

    expect(test.resolver.resolve()).toEqual({
      ok: true,
      invocation: {
        executable: target,
        prefixArgs: [],
        environmentPatch: {},
        displayPath: target,
        canonicalTargetPath: target,
        provenance: "native",
      },
    });
  });
});

describe("Claude invocation identity and environment helpers", () => {
  it("compares every resolver-owned identity field and ignores display-only path changes", () => {
    const base = baseInvocation();
    expect(
      sameClaudeInvocationIdentity(base, {
        ...base,
        displayPath: "C:\\another-display-only-shim.cmd",
      }),
    ).toBe(true);

    const mutations: ResolvedClaudeInvocation[] = [
      { ...base, executable: "C:\\Other\\electron.exe" },
      { ...base, prefixArgs: ["C:\\other\\cli.js"] },
      { ...base, environmentPatch: { ELECTRON_RUN_AS_NODE: "0" } },
      { ...base, canonicalTargetPath: "C:\\other\\cli.js" },
      { ...base, provenance: "native" },
    ];
    for (const mutation of mutations) {
      expect(sameClaudeInvocationIdentity(base, mutation)).toBe(false);
    }
  });

  it("compares environment patch entries by sorted key and value rather than insertion order", () => {
    const base = {
      ...baseInvocation(),
      environmentPatch: { B: "2", A: "1" },
    };
    expect(
      sameClaudeInvocationIdentity(base, {
        ...base,
        environmentPatch: { A: "1", B: "2" },
      }),
    ).toBe(true);
  });

  it("merges only the resolver patch over inherited environment without mutating either input", () => {
    const inherited = Object.freeze({
      ELECTRON_RUN_AS_NODE: "0",
      ANTHROPIC_API_KEY: "preserved-for-the-caller-to-sanitize",
    });
    const invocation = baseInvocation();

    const merged = mergeClaudeInvocationEnvironment(inherited, invocation);

    expect(merged).toEqual({
      ELECTRON_RUN_AS_NODE: "1",
      ANTHROPIC_API_KEY: "preserved-for-the-caller-to-sanitize",
    });
    expect(Object.isFrozen(merged)).toBe(true);
    expect(inherited.ELECTRON_RUN_AS_NODE).toBe("0");
    expect(invocation.environmentPatch).toEqual({ ELECTRON_RUN_AS_NODE: "1" });
  });
});
