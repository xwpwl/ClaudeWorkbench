import type {
  ClaudeWorkbenchAPI,
  ClaudeWorkbenchIpcTransport,
} from '../../shared/types/ipc';
import {
  CLAUDE_WORKBENCH_API_METHOD_KINDS,
  CLAUDE_WORKBENCH_API_METHODS,
  CLAUDE_WORKBENCH_EVENT_METHODS,
} from '../../shared/types/ipc';
import type { PublicIpcTransportEnvelope } from '../../shared/types/publicIpc';

type IsExact<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2)
    ? (<Value>() => Value extends Right ? 1 : 2) extends
      (<Value>() => Value extends Left ? 1 : 2)
      ? true
      : false
    : false;
type Assert<Value extends true> = Value;

type EventMethodKeys = {
  [Key in keyof ClaudeWorkbenchAPI]: ReturnType<ClaudeWorkbenchAPI[Key]> extends () => void
    ? Key
    : never;
}[keyof ClaudeWorkbenchAPI];

type ExpectedEventMethodKeys =
  | 'onClaudeEvent'
  | 'onPermissionRequest'
  | 'onPermissionSettled'
  | 'onWorkflowChanged'
  | 'onModelProviderChanged'
  | 'onCheckpointChanged'
  | 'onTerminalOutput'
  | 'onTerminalExit'
  | 'onMenuCommand';

type ExpectedTransport = {
  [Key in keyof ClaudeWorkbenchAPI]: ClaudeWorkbenchAPI[Key] extends (
    ...args: infer Arguments
  ) => Promise<infer Value>
    ? (...args: Arguments) => Promise<PublicIpcTransportEnvelope<Value>>
    : ClaudeWorkbenchAPI[Key];
};
type ExpectedMethodKinds = {
  [Key in keyof ClaudeWorkbenchAPI]: ReturnType<ClaudeWorkbenchAPI[Key]> extends () => void
    ? 'subscription'
    : 'promise';
};

export type PublicApiTransportKeyContract = Assert<IsExact<
  keyof ClaudeWorkbenchIpcTransport,
  keyof ClaudeWorkbenchAPI
>>;
export type PublicApiTransportEventContract = Assert<IsExact<
  EventMethodKeys,
  ExpectedEventMethodKeys
>>;
export type PublicApiTransportSignatureContract = Assert<IsExact<
  ClaudeWorkbenchIpcTransport,
  ExpectedTransport
>>;
export type PublicApiMethodKindContract = Assert<IsExact<
  typeof CLAUDE_WORKBENCH_API_METHOD_KINDS,
  Readonly<ExpectedMethodKinds>
>>;
export type PublicApiMethodNameContract = Assert<IsExact<
  (typeof CLAUDE_WORKBENCH_API_METHODS)[number],
  keyof ClaudeWorkbenchAPI
>>;
export type PublicApiEventNameContract = Assert<IsExact<
  (typeof CLAUDE_WORKBENCH_EVENT_METHODS)[number],
  ExpectedEventMethodKeys
>>;

declare const readonlyWindowContract: Window;
// @ts-expect-error The installed Main-World facade is immutable.
readonlyWindowContract.api = {} as ClaudeWorkbenchAPI;
export type InternalTransportIsNotPublicWindowApi = Assert<IsExact<
  Extract<keyof Window, '__claudeWorkbenchIpcTransport'>,
  never
>>;
