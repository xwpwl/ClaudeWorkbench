interface Window {
  readonly api: import('./shared/types/ipc').ClaudeWorkbenchAPI;
}

declare const __WORKBENCH_RELEASE_METADATA_JSON__: string;
declare const __WORKBENCH_LOCAL_UPDATE_FIXTURE__: boolean;

declare module '*?worker' {
  const WorkerFactory: new () => Worker;
  export default WorkerFactory;
}
