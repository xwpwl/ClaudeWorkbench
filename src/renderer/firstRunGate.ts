export type FirstRunGate = 'booting' | 'required' | 'read_failed' | 'done';

export async function loadFirstRunGate(
  readVersion: () => Promise<number>,
): Promise<Exclude<FirstRunGate, 'booting'>> {
  try {
    return await readVersion() >= 1 ? 'done' : 'required';
  } catch {
    return 'read_failed';
  }
}

export function shouldShowLegacyEnvironmentCheck(
  claudeInstalled: boolean,
  gate: FirstRunGate,
): boolean {
  return gate === 'done' && !claudeInstalled;
}
