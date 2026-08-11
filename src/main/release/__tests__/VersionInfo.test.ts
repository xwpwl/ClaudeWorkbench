import { describe, expect, it } from 'vitest';
import { buildVersionInfo } from '../VersionInfo';

describe('buildVersionInfo', () => {
  it('returns the release version and safe CI metadata', () => {
    expect(buildVersionInfo({
      version: '1.0.0', electronVersion: '35.6.0', packaged: true,
      environment: {
        WORKBENCH_BUILD_ID: 'win-x64-1042',
        WORKBENCH_COMMIT: '0123456789abcdef',
        WORKBENCH_RELEASE_CHANNEL: 'stable',
      },
    })).toEqual({
      version: '1.0.0', buildId: 'win-x64-1042', commit: '0123456789abcdef',
      channel: 'stable', electronVersion: '35.6.0', packaged: true,
    });
  });

  it('uses deterministic packaged fallbacks when CI metadata is absent', () => {
    expect(buildVersionInfo({ version: '1.0.0', packaged: true, environment: {} }))
      .toMatchObject({ buildId: 'release-1.0.0', commit: 'unknown', channel: 'stable' });
  });

  it('labels unpackaged development builds', () => {
    expect(buildVersionInfo({ version: '1.0.0', packaged: false, environment: {} }).buildId)
      .toBe('development');
  });

  it('never exposes arbitrary environment values', () => {
    const info = buildVersionInfo({
      version: 'bad version', packaged: true,
      environment: {
        WORKBENCH_BUILD_ID: 'build\nsecret',
        WORKBENCH_COMMIT: 'not-a-commit',
        WORKBENCH_RELEASE_CHANNEL: 'stable;token=secret',
        ANTHROPIC_API_KEY: 'do-not-copy',
      },
    });
    expect(info).toMatchObject({
      version: '0.0.0', buildId: 'release-0.0.0', commit: 'unknown', channel: 'stable',
    });
    expect(JSON.stringify(info)).not.toContain('do-not-copy');
  });
});

