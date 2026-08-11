export interface DiffModelPaths {
  original: string;
  modified: string;
}

function encodeModelSegment(value: string, fallback: string): string {
  const normalized = value.trim().replaceAll('\\', '/');
  return encodeURIComponent(normalized || fallback);
}

/**
 * Monaco stores models globally by URI. Include both the workspace identity and
 * the mounted viewer identity so two diff editors can never acquire the same
 * mutable model, even when they show the same relative path in different
 * projects.
 */
export function createDiffModelPaths(
  projectPath: string,
  filePath: string,
  viewerInstanceId: string,
): DiffModelPaths {
  const project = encodeModelSegment(projectPath, 'unknown-project');
  const file = encodeModelSegment(filePath, 'unknown-file');
  const instance = encodeModelSegment(viewerInstanceId, 'unknown-viewer');
  const base = `inmemory://claude-workbench/diff/${project}/${file}/${instance}`;
  return {
    original: `${base}/head`,
    modified: `${base}/worktree`,
  };
}
