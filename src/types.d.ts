interface Window {
  readonly api: import('./shared/types/ipc').ClaudeWorkbenchAPI;
}

declare module '*?worker' {
  const WorkerFactory: new () => Worker;
  export default WorkerFactory;
}
