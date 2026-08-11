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
});
