import { create } from 'zustand';
import type { ClaudeEvent } from '../../shared/types/claude';
import type { SessionStatus } from '../../shared/types/session';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

export interface ToolCall {
  id: string;
  toolName: string;
  toolUseId: string;
  input?: unknown;
  output?: unknown;
  status: 'running' | 'completed' | 'failed';
  timestamp: number;
}

interface ChatState {
  // Messages in current session
  messages: ChatMessage[];
  addUserMessage: (content: string) => void;
  addAssistantMessage: (content: string) => void;
  setMessages: (messages: ChatMessage[]) => void;
  clearMessages: () => void;

  // Current streaming text (being built up from assistant_text chunks)
  streamingText: string;
  setStreamingText: (text: string) => void;
  appendStreamingText: (text: string) => void;
  commitStreamingMessage: () => void;

  // Tool calls
  toolCalls: ToolCall[];
  addToolCall: (call: ToolCall) => void;
  updateToolCall: (id: string, updates: Partial<ToolCall>) => void;
  clearToolCalls: () => void;

  // Events for timeline (work tab) — filtered, no system_init/session_started/thinking/stderr
  events: ClaudeEvent[];
  addEvent: (event: ClaudeEvent) => void;
  clearEvents: () => void;

  // All raw events (for debugging, not displayed in chat)
  rawEvents: ClaudeEvent[];
  addRawEvent: (event: ClaudeEvent) => void;
  clearRawEvents: () => void;

  // Session status — extended with loading_history
  sessionStatus: SessionStatus;
  setSessionStatus: (status: SessionStatus) => void;

  // Usage stats
  usage: { inputTokens: number; outputTokens: number; totalTokens: number } | null;
  setUsage: (usage: { inputTokens: number; outputTokens: number; totalTokens: number } | null) => void;

  // Timing
  startTime: number | null;
  setStartTime: (time: number | null) => void;

  // Current view tab
  activeTab: 'conversation' | 'work';
  setActiveTab: (tab: 'conversation' | 'work') => void;

  // Stderr messages (for diagnostics panel)
  stderrMessages: Array<{ text: string; level: string; timestamp: number }>;
  addStderr: (text: string, level: string) => void;
  clearStderr: () => void;
}

export const useChatStore = create<ChatState>((set, get) => ({
  messages: [],
  addUserMessage: (content) => {
    const message: ChatMessage = {
      id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      role: 'user',
      content,
      timestamp: Date.now(),
    };
    set((state) => ({ messages: [...state.messages, message] }));
  },
  addAssistantMessage: (content) => {
    const message: ChatMessage = {
      id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      role: 'assistant',
      content,
      timestamp: Date.now(),
    };
    set((state) => ({ messages: [...state.messages, message] }));
  },
  setMessages: (messages) => set({ messages }),
  clearMessages: () => set({
    messages: [],
    streamingText: '',
    toolCalls: [],
    events: [],
    rawEvents: [],
    usage: null,
    stderrMessages: [],
  }),

  streamingText: '',
  setStreamingText: (text) => set({ streamingText: text }),
  appendStreamingText: (text) => {
    const current = get().streamingText;
    // Dedup: if the EXACT same text was just appended, skip
    if (current.endsWith(text)) {
      return;
    }
    set({ streamingText: current + text });
  },
  commitStreamingMessage: () => {
    const { streamingText, messages } = get();
    if (!streamingText.trim()) return;
    const message: ChatMessage = {
      id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      role: 'assistant',
      content: streamingText,
      timestamp: Date.now(),
    };
    set({
      messages: [...messages, message],
      streamingText: '',
    });
  },

  toolCalls: [],
  addToolCall: (call) =>
    set((state) => ({ toolCalls: [...state.toolCalls, call] })),
  updateToolCall: (id, updates) =>
    set((state) => ({
      toolCalls: state.toolCalls.map((tc) =>
        tc.id === id ? { ...tc, ...updates } : tc,
      ),
    })),
  clearToolCalls: () => set({ toolCalls: [] }),

  // Filtered events — only events that should appear in the work tab
  events: [],
  addEvent: (event) => {
    // Filter out internal events that should not appear in work timeline
    if (
      event.type === 'system_init' ||
      event.type === 'session_started' ||
      event.type === 'thinking_content' ||
      event.type === 'stderr'
    ) {
      return;
    }
    set((state) => ({ events: [...state.events, event] }));
  },
  clearEvents: () => set({ events: [] }),

  // All raw events (for debugging)
  rawEvents: [],
  addRawEvent: (event) =>
    set((state) => ({ rawEvents: [...state.rawEvents, event] })),
  clearRawEvents: () => set({ rawEvents: [] }),

  sessionStatus: 'idle',
  setSessionStatus: (status) => set({ sessionStatus: status }),

  usage: null,
  setUsage: (usage) => set({ usage }),

  startTime: null,
  setStartTime: (time) => set({ startTime: time }),

  activeTab: 'conversation',
  setActiveTab: (tab) => set({ activeTab: tab }),

  stderrMessages: [],
  addStderr: (text, level) =>
    set((state) => ({
      stderrMessages: [...state.stderrMessages, { text, level, timestamp: Date.now() }],
    })),
  clearStderr: () => set({ stderrMessages: [] }),
}));
