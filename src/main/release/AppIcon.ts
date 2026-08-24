import path from 'node:path';

export interface AppIconPathInput {
  packaged: boolean;
  resourcesPath: string;
  appPath: string;
}

export function resolveAppIconPath(input: AppIconPathInput): string {
  return input.packaged
    ? path.join(input.resourcesPath, 'app-icon.png')
    : path.join(input.appPath, 'build-resources', 'app-icon.png');
}
