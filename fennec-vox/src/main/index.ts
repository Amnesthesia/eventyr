import { app, BrowserWindow, Menu } from 'electron';
import path from 'path';
import { registerIpcHandlers } from './ipc';
import { registerProtocolHandler } from './oauth';

// On Mac, allow only one instance
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); }

let mainWindow: BrowserWindow | null = null;

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width:           900,
    height:          660,
    minWidth:        760,
    minHeight:       560,
    title:           'Fennec Vox',
    titleBarStyle:   'hiddenInset',
    backgroundColor: '#eef3f8',
    webPreferences: {
      preload:          path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration:  false,
    },
  });

  if (process.env['NODE_ENV'] === 'development') {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'] ?? 'http://localhost:5173');
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  return win;
}

function buildMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'Fennec Vox',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'Window',
      submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'front' }],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
  mainWindow = createWindow();
  registerIpcHandlers(mainWindow);
  registerProtocolHandler(() => { /* OAuth results flow through IPC.OAUTH_COMPLETE */ });
  buildMenu();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
  });
});

// Second-instance: restore & focus existing window
app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

// macOS: handle fennecvox:// callback URLs from second instance
app.on('open-url', (_event, url) => {
  const { handleOAuthCallback } = require('./oauth') as typeof import('./oauth');
  handleOAuthCallback(url);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
