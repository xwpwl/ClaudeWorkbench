import React from 'react';
import { useAppStore } from '../stores/appStore';
import { useChatStore } from '../stores/chatStore';
import {
  PanelLeft,
  Terminal,
  PanelRight,
  Settings,
  Cpu,
  Shield,
} from 'lucide-react';

interface StatusBarProps {
  onToggleSidebar: () => void;
  onToggleTerminal: () => void;
  onToggleFilePanel: () => void;
  onOpenSettings: () => void;
}

export function StatusBar({
  onToggleSidebar,
  onToggleTerminal,
  onToggleFilePanel,
  onOpenSettings,
}: StatusBarProps) {
  const { currentProject, claudeInstalled, currentModel, permissionMode } =
    useAppStore();
  const { sessionStatus } = useChatStore();

  const getStatusColor = () => {
    switch (sessionStatus) {
      case 'running':
        return 'bg-blue-500';
      case 'completed':
        return 'bg-green-500';
      case 'failed':
        return 'bg-red-500';
      case 'cancelled':
        return 'bg-gray-500';
      default:
        return 'bg-gray-600';
    }
  };

  const getStatusText = () => {
    switch (sessionStatus) {
      case 'running':
        return 'Running';
      case 'completed':
        return 'Completed';
      case 'failed':
        return 'Failed';
      case 'cancelled':
        return 'Cancelled';
      default:
        return 'Idle';
    }
  };

  return (
    <div className="h-6 flex items-center px-2 bg-[#0a0a0a] border-t border-[#1e1e1e] text-[10px] text-[#525252] select-none">
      {/* Left side */}
      <div className="flex items-center gap-2">
        {/* Sidebar toggle */}
        <button
          onClick={onToggleSidebar}
          className="p-0.5 hover:text-[#a3a3a3] transition-colors"
          title="Toggle sidebar (Ctrl+B)"
        >
          <PanelLeft size={12} />
        </button>

        {/* Terminal toggle */}
        <button
          onClick={onToggleTerminal}
          className="p-0.5 hover:text-[#a3a3a3] transition-colors"
          title="Toggle terminal (Ctrl+J)"
        >
          <Terminal size={12} />
        </button>

        {/* File panel toggle */}
        <button
          onClick={onToggleFilePanel}
          className="p-0.5 hover:text-[#a3a3a3] transition-colors"
          title="Toggle file panel"
        >
          <PanelRight size={12} />
        </button>

        <div className="w-px h-3 bg-[#1e1e1e]" />

        {/* Current project */}
        {currentProject && (
          <span className="flex items-center gap-1">
            <span className="text-[#a3a3a3]">{currentProject.name}</span>
          </span>
        )}
      </div>

      {/* Center - Status */}
      <div className="flex-1 flex items-center justify-center gap-2">
        <div className={`w-1.5 h-1.5 rounded-full ${getStatusColor()}`} />
        <span>{getStatusText()}</span>
      </div>

      {/* Right side */}
      <div className="flex items-center gap-2">
        {/* Claude status */}
        <span className="flex items-center gap-1">
          <Cpu size={10} />
          <span className={claudeInstalled ? 'text-green-400' : 'text-red-400'}>
            {claudeInstalled ? 'Claude' : 'No Claude'}
          </span>
        </span>

        {/* Model */}
        {currentModel && (
          <span className="flex items-center gap-1">
            <span className="text-[#a3a3a3]">{currentModel}</span>
          </span>
        )}

        {/* Permission mode */}
        <span className="flex items-center gap-1">
          <Shield size={10} />
          <span className="capitalize">{permissionMode}</span>
        </span>

        <div className="w-px h-3 bg-[#1e1e1e]" />

        {/* Settings */}
        <button
          onClick={onOpenSettings}
          className="p-0.5 hover:text-[#a3a3a3] transition-colors"
          title="Settings (Ctrl+,)"
        >
          <Settings size={12} />
        </button>
      </div>
    </div>
  );
}
