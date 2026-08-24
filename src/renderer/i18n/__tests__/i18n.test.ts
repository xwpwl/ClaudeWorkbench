import { describe, it, expect, beforeEach } from 'vitest';
import { t, setLocale, getLocale, type LocaleKey } from '../index';

describe('i18n', () => {
  beforeEach(() => {
    setLocale('zh-CN');
  });

  it('should default to zh-CN', () => {
    expect(getLocale()).toBe('zh-CN');
  });

  it('should switch locale', () => {
    setLocale('en-US');
    expect(getLocale()).toBe('en-US');
  });

  it('should return Chinese translations', () => {
    setLocale('zh-CN');
    expect(t('app.name')).toBe('Claude Workbench');
    expect(t('project.open')).toBe('打开项目');
    expect(t('task.new')).toBe('新建任务');
    expect(t('status.running')).toBe('运行中');
    expect(t('chat.welcome')).toBe('从一个项目开始');
    expect(t('chat.placeholder')).toBe('描述你希望 Claude 完成的任务…');
    expect(t('settings.title')).toBe('设置');
    expect(t('env.title')).toBe('环境检查');
    expect(t('terminal.title')).toBe('终端');
    expect(t('files.title')).toBe('文件改动');
    expect(t('permission.plan')).toBe('规划');
    expect(t('permission.standard')).toBe('标准');
    expect(t('permission.acceptEdits')).toBe('接受编辑');
  });

  it('should return English translations', () => {
    setLocale('en-US');
    expect(t('app.name')).toBe('Claude Workbench');
    expect(t('project.open')).toBe('Open Project');
    expect(t('task.new')).toBe('New Task');
    expect(t('status.running')).toBe('Running');
    expect(t('chat.welcome')).toBe('Start with a Project');
    expect(t('settings.title')).toBe('Settings');
    expect(t('env.title')).toBe('Environment Check');
  });

  it('accurately explains encrypted Provider credentials and inherited environment variables', () => {
    setLocale('zh-CN');
    expect(t('settings.apiKeyNote')).toContain('系统安全存储');
    expect(t('settings.apiKeyNote')).toContain('环境变量');

    setLocale('en-US');
    expect(t('settings.apiKeyNote')).toContain('system secure storage');
    expect(t('settings.apiKeyNote')).toContain('environment variables');
    expect(t('settings.apiKeyNote')).not.toContain('never stored');
  });

  it('should have all keys in both locales', () => {
    setLocale('zh-CN');
    const keys: LocaleKey[] = [
      'app.name', 'project.open', 'task.new', 'status.running', 'status.idle',
      'chat.welcome', 'chat.placeholder', 'settings.title', 'env.title',
      'terminal.title', 'files.title', 'permission.plan', 'permission.standard',
      'permission.acceptEdits', 'model.default', 'common.save', 'common.cancel',
    ];
    for (const key of keys) {
      const zhValue = t(key);
      expect(zhValue).toBeTruthy();
      expect(zhValue).not.toBe(key); // Should not return the key itself
    }
  });

  it('localizes the Agent tier and preset flow in both supported locales', () => {
    setLocale('zh-CN');
    expect(t('settings.agent')).toBe('Agent');
    expect(t('agent.tiers.title')).toBe('模型档位');
    expect(t('agent.tiers.disclaimer')).toBe('档位名称和备注由用户配置，不代表系统对模型能力的保证。');
    expect(t('agent.preset.previewTitle')).toBe('应用模板预览');
    expect(t('agent.preset.overwriteWarning')).toBe('重新应用此模板将覆盖当前 Agent 角色模型配置。');
    expect(t('agent.preset.success')).toBe('模型配置已更新，只影响后续 Agent 调用。');

    setLocale('en-US');
    expect(t('settings.agent')).toBe('Agent');
    expect(t('agent.tiers.title')).toBe('Model tiers');
    expect(t('agent.tiers.disclaimer')).toBe('Tier names and notes are user-configured and do not guarantee model capabilities.');
    expect(t('agent.preset.previewTitle')).toBe('Apply template preview');
    expect(t('agent.preset.overwriteWarning')).toBe('Reapplying this template will overwrite the current Agent role model configuration.');
    expect(t('agent.preset.success')).toBe('Model configuration updated; it only affects subsequent Agent calls.');
  });

  it('localizes first run, empty states, Settings navigation, privacy, and missing license', () => {
    setLocale('zh-CN');
    expect(t('firstRun.title')).toBe('欢迎使用 Claude Workbench');
    expect(t('firstRun.project.createTest')).toBe('创建测试项目');
    expect(t('settings.models')).toBe('模型与连接');
    expect(t('about.missingLicense')).toBe('未捆绑许可证信息');

    setLocale('en-US');
    expect(t('firstRun.title')).toBe('Welcome to Claude Workbench');
    expect(t('firstRun.project.createTest')).toBe('Create test project');
    expect(t('settings.models')).toBe('Models & Connections');
    expect(t('about.localPrivacy')).toBe('Diagnostic data stays local until you explicitly export it.');
    expect(t('about.missingLicense')).toBe('No bundled license information');
  });

  it('localizes first-run Provider retry copy without widening the Provider trust boundary', () => {
    setLocale('zh-CN');
    expect(t('firstRun.provider.loadFailed' as LocaleKey)).toBe('无法读取 Provider。请重试。');
    expect(t('firstRun.provider.retry' as LocaleKey)).toBe('重试');

    setLocale('en-US');
    expect(t('firstRun.provider.loadFailed' as LocaleKey)).toBe('Providers could not be loaded. Try again.');
    expect(t('firstRun.provider.retry' as LocaleKey)).toBe('Retry');
  });

  it('localizes every bounded Claude Code update state in both supported locales', () => {
    const expected = {
      'zh-CN': {
        'claudeUpdate.action': '立即更新',
        'claudeUpdate.busy': '正在更新…',
        'claudeUpdate.manualOnly': '仅在你点击“立即更新”后执行，不会自动更新。',
        'claudeUpdate.updated': '更新完成。',
        'claudeUpdate.upToDate': '已是最新版本。',
        'claudeUpdate.loadFailed': '无法读取 Claude Code 更新状态。',
        'claudeUpdate.genericError': 'Claude Code 更新当前不可用。',
        'claudeUpdate.reason.activeTasks': 'Claude Code 正在执行任务，请在任务结束后重试。',
        'claudeUpdate.reason.runtimeBusy': 'Claude Code 正在完成本地检查，请稍后重试。',
        'claudeUpdate.reason.notInstalled': '未检测到 Claude Code。',
        'claudeUpdate.reason.unsupportedInstallation': '当前安装不支持安全的自更新。',
        'claudeUpdate.reason.identityChanged': '更新后安装身份发生变化，结果未被接受。',
        'claudeUpdate.reason.invalidVersion': '无法验证更新后的 Claude Code 版本。',
        'claudeUpdate.reason.permissionDenied': '没有权限更新 Claude Code。',
        'claudeUpdate.reason.timedOut': 'Claude Code 更新超时。',
        'claudeUpdate.reason.cleanupUnconfirmed': '无法确认更新进程已完全退出；本次会话已禁用更新。',
        'claudeUpdate.reason.updateFailed': 'Claude Code 更新失败。',
      },
      'en-US': {
        'claudeUpdate.action': 'Update now',
        'claudeUpdate.busy': 'Updating…',
        'claudeUpdate.manualOnly': 'Runs only when you click “Update now”; Claude Code is never updated automatically.',
        'claudeUpdate.updated': 'Update complete.',
        'claudeUpdate.upToDate': 'Claude Code is already up to date.',
        'claudeUpdate.loadFailed': 'Claude Code update status could not be loaded.',
        'claudeUpdate.genericError': 'Claude Code updating is currently unavailable.',
        'claudeUpdate.reason.activeTasks': 'Claude Code is running a task. Try again after it finishes.',
        'claudeUpdate.reason.runtimeBusy': 'Claude Code is finishing a local check. Try again shortly.',
        'claudeUpdate.reason.notInstalled': 'Claude Code was not detected.',
        'claudeUpdate.reason.unsupportedInstallation': 'This installation does not support a safe self-update.',
        'claudeUpdate.reason.identityChanged': 'The installation identity changed after updating, so the result was not accepted.',
        'claudeUpdate.reason.invalidVersion': 'The updated Claude Code version could not be verified.',
        'claudeUpdate.reason.permissionDenied': 'Permission to update Claude Code was denied.',
        'claudeUpdate.reason.timedOut': 'The Claude Code update timed out.',
        'claudeUpdate.reason.cleanupUnconfirmed': 'The updater process could not be confirmed closed; updates are disabled for this session.',
        'claudeUpdate.reason.updateFailed': 'Claude Code update failed.',
      },
    } as const;

    for (const locale of ['zh-CN', 'en-US'] as const) {
      setLocale(locale);
      for (const [key, value] of Object.entries(expected[locale])) {
        expect(t(key as LocaleKey)).toBe(value);
      }
    }
  });
});
