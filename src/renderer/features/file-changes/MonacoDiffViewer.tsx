import React, { useId, useState } from 'react';
import { DiffEditor, loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker';
import CssWorker from 'monaco-editor/language/css/css.worker.js?worker';
import HtmlWorker from 'monaco-editor/language/html/html.worker.js?worker';
import JsonWorker from 'monaco-editor/language/json/json.worker.js?worker';
import TypeScriptWorker from 'monaco-editor/language/typescript/ts.worker.js?worker';
import { createDiffModelPaths } from './diffModelIdentity';

interface MonacoEnvironmentShape {
  getWorker?: (moduleId: string, label: string) => Worker;
}

const workerGlobal = globalThis as typeof globalThis & {
  MonacoEnvironment?: MonacoEnvironmentShape;
};

workerGlobal.MonacoEnvironment = {
  ...workerGlobal.MonacoEnvironment,
  getWorker: (_moduleId, label) => {
    if (label === 'json') return new JsonWorker();
    if (label === 'css' || label === 'scss' || label === 'less') return new CssWorker();
    if (label === 'html' || label === 'handlebars' || label === 'razor') return new HtmlWorker();
    if (label === 'typescript' || label === 'javascript') return new TypeScriptWorker();
    return new EditorWorker();
  },
};
loader.config({ monaco });

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  c: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  cs: 'csharp',
  css: 'css',
  go: 'go',
  h: 'c',
  hpp: 'cpp',
  html: 'html',
  java: 'java',
  js: 'javascript',
  json: 'json',
  jsx: 'javascript',
  md: 'markdown',
  mjs: 'javascript',
  py: 'python',
  rs: 'rust',
  scss: 'scss',
  sh: 'shell',
  sql: 'sql',
  ts: 'typescript',
  tsx: 'typescript',
  xml: 'xml',
  yaml: 'yaml',
  yml: 'yaml',
};

export function languageForFile(filePath: string): string {
  const fileName = filePath.split('/').at(-1)?.toLocaleLowerCase() ?? '';
  if (fileName === 'dockerfile') return 'dockerfile';
  if (fileName === 'makefile') return 'plaintext';
  const extension = fileName.includes('.') ? fileName.split('.').at(-1) ?? '' : '';
  return LANGUAGE_BY_EXTENSION[extension] ?? 'plaintext';
}

export interface MonacoDiffViewerProps {
  projectPath: string;
  filePath: string;
  oldContent: string | null;
  newContent: string | null;
  mode: 'unified' | 'split';
  theme: 'light' | 'dark';
}

export default function MonacoDiffViewer({
  projectPath,
  filePath,
  oldContent,
  newContent,
  mode,
  theme,
}: MonacoDiffViewerProps) {
  const viewerInstanceId = useId();
  // Keep one URI pair for this mounted editor. Content can change in place,
  // while other editors and projects always receive a different pair.
  const [modelPaths] = useState(() => (
    createDiffModelPaths(projectPath, filePath, viewerInstanceId)
  ));
  return (
    <DiffEditor
      height="360px"
      language={languageForFile(filePath)}
      original={oldContent ?? ''}
      modified={newContent ?? ''}
      originalModelPath={modelPaths.original}
      modifiedModelPath={modelPaths.modified}
      theme={theme === 'dark' ? 'vs-dark' : 'light'}
      loading={(
        <div className="flex h-[360px] items-center justify-center text-xs" style={{ color: 'var(--text-tertiary)' }}>
          正在加载差异查看器…
        </div>
      )}
      options={{
        ariaLabel: `${filePath} HEAD 到工作区差异`,
        automaticLayout: true,
        diffAlgorithm: 'advanced',
        enableSplitViewResizing: true,
        ignoreTrimWhitespace: false,
        minimap: { enabled: false },
        originalEditable: false,
        readOnly: true,
        renderSideBySide: mode === 'split',
        scrollBeyondLastLine: false,
        wordWrap: 'off',
      }}
    />
  );
}
