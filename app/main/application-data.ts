import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const APPLICATION_DATA_DIRECTORY = ".agent-ppt";
export const ELECTRON_USER_DATA_DIRECTORY = "electron";
export const APPLICATION_DATA_ENVIRONMENT_VARIABLE = "AGENT_PPT_DATA_DIR";

interface ApplicationDataOptions {
  environment?: NodeJS.ProcessEnv;
  homeDirectory?: string;
}

interface ElectronPathConfigurator {
  setPath(name: "userData", path: string): void;
}

/**
 * Returns the single application-owned persistence root.
 *
 * AGENT_PPT_DATA_DIR remains an explicit override for tests and isolated
 * development runs. Production startup sets it to the home-directory root
 * before any service initializes.
 */
export function getApplicationDataRoot(options: ApplicationDataOptions = {}): string {
  const environment = options.environment ?? process.env;
  const override = environment[APPLICATION_DATA_ENVIRONMENT_VARIABLE]?.trim();
  return override || join(options.homeDirectory ?? homedir(), APPLICATION_DATA_DIRECTORY);
}

export function getElectronUserDataRoot(applicationDataRoot: string): string {
  return join(applicationDataRoot, ELECTRON_USER_DATA_DIRECTORY);
}

/**
 * Configures Electron before app.whenReady(), so Chromium state and Main
 * process persistence share one root without flattening their contents.
 */
export function configureApplicationDataRoot(
  electronApp: ElectronPathConfigurator,
  options: ApplicationDataOptions = {},
): {
  applicationDataRoot: string;
  electronUserDataRoot: string;
} {
  const applicationDataRoot = getApplicationDataRoot({
    ...options,
    environment: {
      ...(options.environment ?? process.env),
      [APPLICATION_DATA_ENVIRONMENT_VARIABLE]: undefined,
    },
  });
  const electronUserDataRoot = getElectronUserDataRoot(applicationDataRoot);
  mkdirSync(electronUserDataRoot, { recursive: true });
  process.env[APPLICATION_DATA_ENVIRONMENT_VARIABLE] = applicationDataRoot;
  electronApp.setPath("userData", electronUserDataRoot);
  return { applicationDataRoot, electronUserDataRoot };
}
