import {
  agentPreferencesSchema,
  type ConfigurationManagement,
  discoverAgentModelsSchema,
  saveAgentVendorSchema,
  updateSearchCredentialSchema,
  vendorIdSchema,
} from "@agent-harness/configuration/configuration-contract";
import { agentSettingsSchema } from "@agent-harness/configuration/settings";
import type { IpcMain, IpcMainInvokeEvent } from "electron";

export function registerAgentConfigurationIpc(
  ipcMain: Pick<IpcMain, "handle">,
  management: ConfigurationManagement,
  assertTrusted: (event: IpcMainInvokeEvent) => void,
): void {
  ipcMain.handle("agent-configuration:get", (event) => {
    assertTrusted(event);
    return management.getSnapshot();
  });
  ipcMain.handle("agent-configuration:initialize", (event, input: unknown) => {
    assertTrusted(event);
    return management.initialize(
      input === undefined ? undefined : agentSettingsSchema.parse(input),
    );
  });
  ipcMain.handle("agent-configuration:save-vendor", (event, input: unknown) => {
    assertTrusted(event);
    return management.saveVendor(saveAgentVendorSchema.parse(input));
  });
  ipcMain.handle("agent-configuration:delete-vendor", (event, input: unknown) => {
    assertTrusted(event);
    return management.deleteVendor(vendorIdSchema.parse(input));
  });
  ipcMain.handle("agent-configuration:save-preferences", (event, input: unknown) => {
    assertTrusted(event);
    return management.savePreferences(agentPreferencesSchema.parse(input));
  });
  ipcMain.handle("agent-configuration:update-search-credential", (event, input: unknown) => {
    assertTrusted(event);
    return management.updateSearchCredential(updateSearchCredentialSchema.parse(input));
  });
  ipcMain.handle("agent-configuration:list-remote-models", (event, input: unknown) => {
    assertTrusted(event);
    return management.listRemoteModels(discoverAgentModelsSchema.parse(input));
  });
}
