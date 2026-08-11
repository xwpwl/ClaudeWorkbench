export type CommandCategory =
  | 'project'
  | 'task'
  | 'history'
  | 'settings'
  | 'model'
  | 'permission'
  | 'view';

export type WorkbenchCommandId =
  | 'project.open'
  | 'project.search'
  | 'task.new'
  | 'task.search'
  | 'task.switch'
  | 'task.send'
  | 'task.send-plan'
  | 'history.refresh'
  | 'settings.open'
  | 'model.switch'
  | 'permission.switch'
  | 'terminal.open'
  | 'diff.open'
  | 'command-palette.open';

export interface CommandShortcut {
  key: string;
  ctrlOrMeta: boolean;
  shift?: boolean;
  alt?: boolean;
  /** Global commands opt in explicitly instead of stealing normal editor input. */
  allowInEditable?: boolean;
  /** Modal-safe shortcuts are considered while a command surface owns focus. */
  allowWhenModalOpen?: boolean;
  /** Resolves exact-modifier conflicts such as Ctrl+P and Ctrl+Shift+P. */
  priority?: number;
}

export interface WorkbenchCommandDefinition {
  id: WorkbenchCommandId;
  title: string;
  description: string;
  category: CommandCategory;
  keywords: readonly string[];
  shortcut?: CommandShortcut;
}

export const WORKBENCH_COMMANDS: readonly WorkbenchCommandDefinition[] = [
  {
    id: 'project.open',
    title: '打开项目',
    description: '选择并打开一个本地项目',
    category: 'project',
    keywords: ['open', 'folder', '目录', '项目'],
  },
  {
    id: 'task.switch',
    title: '切换任务',
    description: '选择当前项目中的任务',
    category: 'task',
    keywords: ['switch', 'session', '切换', '会话'],
  },
  {
    id: 'history.refresh',
    title: '刷新历史',
    description: '重新读取当前项目的 Claude 与 Workbench 历史',
    category: 'history',
    keywords: ['refresh', 'reload', '刷新', '历史'],
  },
  {
    id: 'settings.open',
    title: '打开设置',
    description: '打开 Workbench 设置',
    category: 'settings',
    keywords: ['settings', 'preferences', '设置'],
  },
  {
    id: 'model.switch',
    title: '切换模型',
    description: '选择当前任务使用的模型',
    category: 'model',
    keywords: ['model', 'mimo', 'claude', '模型'],
  },
  {
    id: 'permission.switch',
    title: '切换权限模式',
    description: '选择当前任务的 Claude Code 权限策略',
    category: 'permission',
    keywords: ['permission', 'plan', '权限', '模式'],
  },
  {
    id: 'terminal.open',
    title: '打开终端',
    description: '显示或隐藏当前项目终端',
    category: 'view',
    keywords: ['terminal', 'shell', '终端'],
  },
  {
    id: 'diff.open',
    title: '查看 Diff',
    description: '打开本次任务的代码修改',
    category: 'view',
    keywords: ['diff', 'changes', '修改', '代码审查'],
  },
  {
    id: 'task.new',
    title: '新建任务',
    description: '在当前项目中创建新任务',
    category: 'task',
    keywords: ['new', 'task', '新建', '任务'],
    shortcut: {
      key: 'n',
      ctrlOrMeta: true,
      allowInEditable: true,
      priority: 60,
    },
  },
  {
    id: 'project.search',
    title: '搜索项目',
    description: '打开项目快速搜索',
    category: 'project',
    keywords: ['find', 'project', '搜索', '项目'],
    shortcut: {
      key: 'p',
      ctrlOrMeta: true,
      allowInEditable: true,
      priority: 60,
    },
  },
  {
    id: 'task.search',
    title: '搜索任务',
    description: '打开任务快速搜索',
    category: 'task',
    keywords: ['find', 'task', 'session', '搜索', '任务'],
    shortcut: {
      key: 'k',
      ctrlOrMeta: true,
      allowInEditable: true,
      priority: 60,
    },
  },
  {
    id: 'command-palette.open',
    title: '打开命令面板',
    description: '搜索并运行 Workbench 命令',
    category: 'view',
    keywords: ['command', 'palette', '命令', '面板'],
    shortcut: {
      key: 'p',
      ctrlOrMeta: true,
      shift: true,
      allowInEditable: true,
      allowWhenModalOpen: true,
      priority: 100,
    },
  },
  {
    id: 'task.send',
    title: '发送任务',
    description: '发送当前输入',
    category: 'task',
    keywords: ['send', 'run', '发送', '运行'],
    shortcut: {
      key: 'enter',
      ctrlOrMeta: true,
      allowInEditable: true,
      priority: 80,
    },
  },
  {
    id: 'task.send-plan',
    title: '以规划模式发送',
    description: '仅分析和规划，不允许修改文件',
    category: 'task',
    keywords: ['plan', 'analyze', '规划', '只读'],
    shortcut: {
      key: 'enter',
      ctrlOrMeta: true,
      shift: true,
      allowInEditable: true,
      priority: 100,
    },
  },
] as const;

export function formatCommandShortcut(shortcut?: CommandShortcut): string {
  if (!shortcut) return '';
  const parts: string[] = [];
  if (shortcut.ctrlOrMeta) parts.push('Ctrl');
  if (shortcut.shift) parts.push('Shift');
  if (shortcut.alt) parts.push('Alt');
  const key = shortcut.key.length === 1
    ? shortcut.key.toUpperCase()
    : shortcut.key[0].toUpperCase() + shortcut.key.slice(1);
  parts.push(key);
  return parts.join('+');
}

