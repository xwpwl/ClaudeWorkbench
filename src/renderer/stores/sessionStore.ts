import { create } from 'zustand';
import type { SessionSummary, SessionDetail, SessionStatus, HistoricalMessage } from '../../shared/types/session';

interface SessionState {
  // Sessions list for current project (workbench + merged history)
  sessions: SessionSummary[];
  setSessions: (sessions: SessionSummary[]) => void;
  addSession: (session: SessionSummary) => void;
  removeSession: (sessionId: string) => void;
  mergeHistorySessions: (historySessions: SessionSummary[]) => void;

  // Current active session
  currentSession: SessionSummary | null;
  setCurrentSession: (session: SessionSummary | null) => void;

  // Session detail (messages + events)
  sessionDetail: SessionDetail | null;
  setSessionDetail: (detail: SessionDetail | null) => void;

  // Historical messages (loaded from local Claude Code transcripts)
  historicalMessages: HistoricalMessage[];
  setHistoricalMessages: (messages: HistoricalMessage[]) => void;

  // Active Claude session ID (from CLI)
  claudeSessionId: string | null;
  setClaudeSessionId: (id: string | null) => void;

  // Update session status
  updateSessionStatus: (sessionId: string, status: SessionStatus) => void;

  // Loading state for history
  isLoadingHistory: boolean;
  setIsLoadingHistory: (loading: boolean) => void;

  // History refresh count
  historyCount: number;
  setHistoryCount: (count: number) => void;
}

export const useSessionStore = create<SessionState>((set) => ({
  sessions: [],
  setSessions: (sessions) => set({ sessions }),
  addSession: (session) =>
    set((state) => ({ sessions: [session, ...state.sessions] })),
  removeSession: (sessionId) =>
    set((state) => ({
      sessions: state.sessions.filter((s) => s.id !== sessionId),
    })),
  mergeHistorySessions: (historySessions) =>
    set((state) => {
      // Merge by sessionId, avoiding duplicates
      const existingIds = new Set(state.sessions.map((s) => s.id));
      const newSessions = historySessions.filter((s) => !existingIds.has(s.id));
      // Also update existing sessions that have history counterparts
      const merged = state.sessions.map((s) => {
        const history = historySessions.find((h) => h.id === s.id);
        if (history && s.source === 'workbench') {
          // Enrich workbench session with history metadata
          return { ...s, summary: history.summary, gitBranch: history.gitBranch };
        }
        return s;
      });
      return {
        sessions: [...merged, ...newSessions].sort(
          (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
        ),
      };
    }),

  currentSession: null,
  setCurrentSession: (session) => set({ currentSession: session }),

  sessionDetail: null,
  setSessionDetail: (detail) => set({ sessionDetail: detail }),

  historicalMessages: [],
  setHistoricalMessages: (messages) => set({ historicalMessages: messages }),

  claudeSessionId: null,
  setClaudeSessionId: (id) => set({ claudeSessionId: id }),

  updateSessionStatus: (sessionId, status) =>
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === sessionId ? { ...s, status } : s,
      ),
      currentSession:
        state.currentSession?.id === sessionId
          ? { ...state.currentSession, status }
          : state.currentSession,
    })),

  isLoadingHistory: false,
  setIsLoadingHistory: (loading) => set({ isLoadingHistory: loading }),

  historyCount: 0,
  setHistoryCount: (count) => set({ historyCount: count }),
}));
