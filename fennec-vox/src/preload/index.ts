import { contextBridge, ipcRenderer } from 'electron';
import { IPC } from '@shared/ipc';
import type { ConversionOptions, OAuthProvider, ProgressEvent, OAuthResult } from '@shared/ipc';

// Expose a typed, minimal surface to the renderer via window.api
const api = {
  // File pickers
  selectEpub:      (): Promise<string | null>                    => ipcRenderer.invoke(IPC.SELECT_EPUB),
  selectOutputDir: (): Promise<string | null>                    => ipcRenderer.invoke(IPC.SELECT_OUTPUT_DIR),

  // Credentials
  getCredentials:  (): Promise<{ anthropicKey: string; openaiKey: string }> =>
    ipcRenderer.invoke(IPC.GET_CREDENTIALS),
  saveCredentials: (c: { anthropicKey: string; openaiKey: string }): Promise<void> =>
    ipcRenderer.invoke(IPC.SAVE_CREDENTIALS, c),

  // OAuth
  startOAuth: (provider: OAuthProvider): Promise<OAuthResult> =>
    ipcRenderer.invoke(IPC.START_OAUTH, provider),

  // Conversion
  startConversion: (opts: ConversionOptions): Promise<{ ok?: boolean; error?: string }> =>
    ipcRenderer.invoke(IPC.START_CONVERSION, opts),
  stopConversion: (): Promise<{ ok?: boolean; error?: string }> =>
    ipcRenderer.invoke(IPC.STOP_CONVERSION),

  // Event subscriptions (return unsubscribe function)
  onProgress: (cb: (event: ProgressEvent) => void): (() => void) => {
    const handler = (_: Electron.IpcRendererEvent, e: ProgressEvent) => cb(e);
    ipcRenderer.on(IPC.CONVERSION_PROGRESS, handler);
    return () => ipcRenderer.off(IPC.CONVERSION_PROGRESS, handler);
  },
  onLog: (cb: (line: string) => void): (() => void) => {
    const handler = (_: Electron.IpcRendererEvent, line: string) => cb(line);
    ipcRenderer.on(IPC.CONVERSION_LOG, handler);
    return () => ipcRenderer.off(IPC.CONVERSION_LOG, handler);
  },
  onComplete: (cb: (event: ProgressEvent & { type: 'complete' }) => void): (() => void) => {
    const handler = (_: Electron.IpcRendererEvent, e: ProgressEvent) => cb(e as ProgressEvent & { type: 'complete' });
    ipcRenderer.on(IPC.CONVERSION_COMPLETE, handler);
    return () => ipcRenderer.off(IPC.CONVERSION_COMPLETE, handler);
  },
  onError: (cb: (message: string) => void): (() => void) => {
    const handler = (_: Electron.IpcRendererEvent, msg: string) => cb(msg);
    ipcRenderer.on(IPC.CONVERSION_ERROR, handler);
    return () => ipcRenderer.off(IPC.CONVERSION_ERROR, handler);
  },
  onOAuthComplete: (cb: (result: OAuthResult) => void): (() => void) => {
    const handler = (_: Electron.IpcRendererEvent, r: OAuthResult) => cb(r);
    ipcRenderer.on(IPC.OAUTH_COMPLETE, handler);
    return () => ipcRenderer.off(IPC.OAUTH_COMPLETE, handler);
  },
};

contextBridge.exposeInMainWorld('api', api);

// Type declaration for the renderer — referenced via global augmentation in renderer/src/env.d.ts
export type ElectronAPI = typeof api;
