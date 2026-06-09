import { ipcMain, dialog, BrowserWindow } from 'electron';
import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import { getCredentials, saveCredentials } from './keychain';
import { startOAuth } from './oauth';
import { IPC } from '@shared/ipc';
import type { ConversionOptions, OAuthProvider } from '@shared/ipc';

let activeProcess: ChildProcess | null = null;

// Resolve the path to the compiled convert.js script:
//   - dev:        ../epub-to-audiobook/dist/convert.js
//   - production: resources/convert.js (via extraResources in electron-builder)
function resolveScriptPath(): string {
  if (process.env['NODE_ENV'] === 'development') {
    return path.resolve(__dirname, '../../../epub-to-audiobook/dist/convert.js');
  }
  return path.join(process.resourcesPath, 'convert.js');
}

export function registerIpcHandlers(win: BrowserWindow): void {

  // ── File / folder pickers ─────────────────────────────────────────────────

  ipcMain.handle(IPC.SELECT_EPUB, async () => {
    const result = await dialog.showOpenDialog(win, {
      title:       'Select EPUB file',
      filters:     [{ name: 'EPUB', extensions: ['epub'] }],
      properties:  ['openFile'],
    });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });

  ipcMain.handle(IPC.SELECT_OUTPUT_DIR, async () => {
    const result = await dialog.showOpenDialog(win, {
      title:      'Select output directory',
      properties: ['openDirectory', 'createDirectory'],
    });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });

  // ── Credentials ───────────────────────────────────────────────────────────

  ipcMain.handle(IPC.GET_CREDENTIALS, () => getCredentials());

  ipcMain.handle(IPC.SAVE_CREDENTIALS, (_event, creds: { anthropicKey: string; openaiKey: string }) => {
    return saveCredentials(creds);
  });

  // ── OAuth ────────────────────────────────────────────────────────────────

  ipcMain.handle(IPC.START_OAUTH, async (_event, provider: OAuthProvider) => {
    const result = await startOAuth(provider);
    win.webContents.send(IPC.OAUTH_COMPLETE, result);
    return result;
  });

  // ── Conversion ────────────────────────────────────────────────────────────

  ipcMain.handle(IPC.START_CONVERSION, async (_event, opts: ConversionOptions) => {
    if (activeProcess) return { error: 'A conversion is already running.' };

    const { anthropicKey, openaiKey } = await getCredentials();
    if (!openaiKey) {
      return { error: 'OpenAI API key is required. Configure it in Settings.' };
    }

    const scriptPath = resolveScriptPath();

    const args: string[] = [
      scriptPath,
      opts.epubPath,
      '--voice',        opts.voice,
      '--format',       opts.format,
      '--tts-model',    opts.ttsModel,
      '--chunk-size',   String(opts.chunkSize),
      '--concurrency',  String(opts.concurrency),
      '--output-dir',   opts.outputDir,
      '--yes',
    ];
    if (opts.resumeFrom !== undefined) {
      args.push('--resume-from', String(opts.resumeFrom));
    }

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      OPENAI_API_KEY: openaiKey,
      ...(anthropicKey ? { ANTHROPIC_API_KEY: anthropicKey } : {}),
    };

    activeProcess = spawn(process.execPath, args, { env });

    activeProcess.stdout?.on('data', (chunk: Buffer) => {
      const lines = chunk.toString().split('\n').filter(Boolean);
      for (const line of lines) {
        win.webContents.send(IPC.CONVERSION_LOG, line);
        if (line.startsWith('[PROGRESS] ')) {
          try {
            const event = JSON.parse(line.slice('[PROGRESS] '.length));
            win.webContents.send(IPC.CONVERSION_PROGRESS, event);
            if (event.type === 'complete') {
              win.webContents.send(IPC.CONVERSION_COMPLETE, event);
            }
          } catch { /* malformed JSON — treat as plain log */ }
        }
      }
    });

    activeProcess.stderr?.on('data', (chunk: Buffer) => {
      win.webContents.send(IPC.CONVERSION_LOG, chunk.toString());
    });

    activeProcess.on('close', code => {
      activeProcess = null;
      if (code !== 0) {
        win.webContents.send(IPC.CONVERSION_ERROR, `Process exited with code ${code ?? 'unknown'}`);
      }
    });

    return { ok: true };
  });

  ipcMain.handle(IPC.STOP_CONVERSION, () => {
    if (activeProcess) {
      activeProcess.kill('SIGTERM');
      activeProcess = null;
      return { ok: true };
    }
    return { error: 'No active conversion.' };
  });
}
