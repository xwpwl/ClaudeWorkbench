import { useCallback, useEffect, useState } from 'react';
import type {
  IntegrationDiagnostic,
  McpServerIntegration,
  SkillDocument,
  SkillIntegration,
} from '../../../shared/types/integrations';
import type { Project } from '../../../shared/types/project';
import { useAppStore } from '../../stores/appStore';
import { IntegrationsPanel } from './IntegrationsPanel';
import type { IntegrationTab } from './IntegrationsPanel';

export interface IntegrationsDialogProps {
  project: Project;
  onClose: () => void;
  initialTab?: IntegrationTab;
}

export function IntegrationsDialog({ project, onClose, initialTab = 'mcp' }: IntegrationsDialogProps) {
  const [mcpServers, setMcpServers] = useState<McpServerIntegration[]>([]);
  const [skills, setSkills] = useState<SkillIntegration[]>([]);
  const [diagnostics, setDiagnostics] = useState<IntegrationDiagnostic[]>([]);
  const [selectedSkill, setSelectedSkill] = useState<SkillDocument | null>(null);
  const [testMessages, setTestMessages] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [mcp, skillResult] = await Promise.all([
        window.api.discoverMcp(project.id, project.path),
        window.api.discoverSkills(project.id, project.path),
      ]);
      setMcpServers(mcp.servers);
      setSkills(skillResult.skills);
      setDiagnostics([...mcp.diagnostics, ...skillResult.diagnostics]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法读取集成配置');
    } finally {
      setLoading(false);
    }
  }, [project.id, project.path]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div
      className="fixed inset-0 z-[65] flex items-center justify-center p-5"
      style={{ background: 'var(--bg-overlay)' }}
      role="presentation"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target) onClose();
      }}
    >
      <div
        className="h-[min(760px,90vh)] w-[min(920px,94vw)] overflow-hidden rounded-xl border shadow-xl"
        style={{ background: 'var(--bg-primary)', borderColor: 'var(--border-primary)' }}
        role="dialog"
        aria-modal="true"
        aria-label="MCP 与 Skills 管理"
      >
        <IntegrationsPanel
          initialTab={initialTab}
          mcpServers={mcpServers}
          skills={skills}
          diagnostics={diagnostics}
          selectedSkill={selectedSkill}
          loading={loading}
          error={error}
          mcpTestMessages={testMessages}
          onRefresh={() => void refresh()}
          onClose={onClose}
          onCloseSkill={() => setSelectedSkill(null)}
          onViewSkill={(skill) => {
            void window.api.readSkill(project.id, project.path, skill)
              .then(setSelectedSkill)
              .catch((reason: unknown) => {
                setError(reason instanceof Error ? reason.message : '无法读取 SKILL.md');
              });
          }}
          onSetMcpEnabled={(server, enabled) => {
            void window.api.setMcpEnabled(project.id, server.name, enabled)
              .then((settings) => {
                useAppStore.getState().setCurrentProjectSettings(settings);
                return refresh();
              })
              .catch((reason: unknown) => {
                setError(reason instanceof Error ? reason.message : '无法更新项目 MCP 状态');
              });
          }}
          onTestMcp={(server) => {
            setTestMessages((current) => ({ ...current, [server.id]: '正在检查…' }));
            void window.api.testMcp(project.id, project.path, server.id)
              .then((result) => {
                setTestMessages((current) => ({
                  ...current,
                  [server.id]: result.message,
                }));
              })
              .catch((reason: unknown) => {
                setTestMessages((current) => ({
                  ...current,
                  [server.id]: reason instanceof Error ? reason.message : '检查失败',
                }));
              });
          }}
        />
      </div>
    </div>
  );
}
