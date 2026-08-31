/**
 * Jest stub for the electron main process.
 *
 * jest.config.ts maps `^electron$` to this file because backend singletons
 * (auth-manager, frontend-communicator, etc.) import electron APIs that don't
 * exist under node/jest. Every export is a jest.fn() (or plain object containing
 * jest.fn()s) so tests can assert against calls made through them.
 *
 * Note: clearMocks is true, so calls recorded here are cleared before each test.
 */

export const ipcMain = {
    on: jest.fn(),
    once: jest.fn(),
    handle: jest.fn(),
    removeAllListeners: jest.fn(),
    emit: jest.fn()
};

export const ipcRenderer = {
    on: jest.fn(),
    once: jest.fn(),
    send: jest.fn(),
    sendSync: jest.fn(),
    removeAllListeners: jest.fn()
};

export const app = {
    getPath: jest.fn(() => "/tmp/firebot-test"),
    // data-access.ts reads both at module scope, so any test importing that
    // chain needs them to exist.
    getAppPath: jest.fn(() => "/tmp/firebot-test"),
    isPackaged: false,
    getVersion: jest.fn(() => "0.0.0-test"),
    isReady: jest.fn(() => true),
    whenReady: jest.fn(() => Promise.resolve()),
    focus: jest.fn(),
    on: jest.fn(),
    relaunch: jest.fn(),
    quit: jest.fn()
};

export const shell = {
    openExternal: jest.fn(() => Promise.resolve()),
    openPath: jest.fn(() => Promise.resolve("")),
    showItemInFolder: jest.fn(),
    beep: jest.fn()
};

export class BrowserWindow {
    loadURL = jest.fn();
    webContents = {
        send: jest.fn()
    } as unknown as BrowserWindow["webContents"];
}

export const Notification = {
    isSupported: jest.fn(() => false)
};

export const dialog = {
    showOpenDialog: jest.fn(),
    showSaveDialog: jest.fn(),
    showMessageBox: jest.fn()
};

export const screen = {
    getPrimaryDisplay: jest.fn(() => ({ workAreaSize: { width: 1920, height: 1080 } })),
    getAllDisplays: jest.fn(() => [])
};

const electronStub = {
    ipcMain,
    ipcRenderer,
    app,
    shell,
    BrowserWindow,
    Notification,
    dialog,
    screen
};

export default electronStub;