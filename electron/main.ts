// Electron shell: runs the same server in-process on a free local port and
// shows the same frontend in a window. No Node access is given to the page.
import fs from "node:fs";
import path from "node:path";
import { app, BrowserWindow, dialog, Menu, shell, type MenuItemConstructorOptions } from "electron";
import { startServer, type RunningServer } from "../server/app";
import { resolveLauncher, type GapSetting } from "../server/launcher";

interface Config {
  lastRoot?: string;
  gap: GapSetting;
}

const configFile = () => path.join(app.getPath("userData"), "config.json");

function loadConfig(): Config {
  try {
    const parsed = JSON.parse(fs.readFileSync(configFile(), "utf8")) as Partial<Config>;
    return { lastRoot: parsed.lastRoot, gap: parsed.gap ?? { mode: "auto" } };
  } catch {
    return { gap: { mode: "auto" } };
  }
}

function saveConfig(config: Config) {
  fs.mkdirSync(path.dirname(configFile()), { recursive: true });
  fs.writeFileSync(configFile(), JSON.stringify(config, null, 2));
}

let config: Config;
let win: BrowserWindow | null = null;
let server: RunningServer | null = null;

async function chooseFolder(): Promise<string | null> {
  const result = await dialog.showOpenDialog({
    title: "Choose the folder with your GAP files",
    defaultPath: config.lastRoot ?? app.getPath("documents"),
    properties: ["openDirectory", "createDirectory"]
  });
  return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
}

/** (Re)starts the server for `root` and shows it in the window. */
async function openProject(root: string) {
  if (server) {
    await server.close().catch(() => {});
    server = null;
  }
  config.lastRoot = root;
  saveConfig(config);

  const launcher = resolveLauncher(config.gap);
  server = await startServer({
    root,
    launcher,
    port: 0,
    distDir: path.join(app.getAppPath(), "dist")
  });

  if (!win) createWindow();
  win!.setTitle(`GAP IDE — ${path.basename(root)}`);
  await win!.loadURL(server.url);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: "#0d1117",
    title: "GAP IDE",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  // Keep the page title out of the window title (it would replace the folder).
  win.on("page-title-updated", (event) => event.preventDefault());
  // Links open in the system browser; the window only shows the local app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (server && url.startsWith(server.url)) return;
    event.preventDefault();
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
  });
  win.on("closed", () => {
    win = null;
  });
}

async function locateGap() {
  const windows = process.platform === "win32";
  const result = await dialog.showOpenDialog({
    title: windows ? "Choose the GAP installation folder (e.g. GAP-4.16.0)" : "Choose the gap executable",
    defaultPath: windows ? process.env.ProgramFiles : "/usr/local/bin",
    properties: windows ? ["openDirectory"] : ["openFile", "showHiddenFiles"]
  });
  if (result.canceled || result.filePaths.length === 0) return;
  config.gap = { mode: windows ? "cygwin" : "native", path: result.filePaths[0] };
  await restartWithGapSetting();
}

async function setGapMode(gap: GapSetting) {
  config.gap = gap;
  await restartWithGapSetting();
}

async function restartWithGapSetting() {
  saveConfig(config);
  buildMenu();
  if (config.lastRoot) await openProject(config.lastRoot);
}

function buildMenu() {
  const isMac = process.platform === "darwin";
  const gapItems: MenuItemConstructorOptions[] = [
    { label: "Locate GAP…", click: () => void locateGap() },
    {
      label: "Find GAP automatically",
      type: "radio",
      checked: config.gap.mode === "auto" && !config.gap.path,
      click: () => void setGapMode({ mode: "auto" })
    }
  ];
  if (process.platform === "win32") {
    gapItems.push({
      label: "Use GAP from WSL",
      type: "radio",
      checked: config.gap.mode === "wsl",
      click: () => void setGapMode({ mode: "wsl" })
    });
  }
  gapItems.push(
    { type: "separator" },
    { label: "Install GAP…", click: () => void shell.openExternal("https://www.gap-system.org/install/") }
  );

  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: "appMenu" as const }] : []),
    {
      label: "File",
      submenu: [
        {
          label: "Open Folder…",
          accelerator: "CmdOrCtrl+O",
          click: async () => {
            const folder = await chooseFolder();
            if (folder) await openProject(folder);
          }
        },
        {
          label: "Show Folder in File Manager",
          click: () => config.lastRoot && void shell.openPath(config.lastRoot)
        },
        { type: "separator" },
        isMac ? { role: "close" } : { role: "quit" }
      ]
    },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" }
      ]
    },
    { label: "GAP", submenu: gapItems },
    {
      role: "help",
      submenu: [
        { label: "GAP documentation", click: () => void shell.openExternal("https://docs.gap-system.org/") },
        { label: "GAP IDE on GitHub", click: () => void shell.openExternal("https://github.com/pfagandini/gap-ide") },
        {
          label: "Settings and logs folder",
          click: () => void shell.openPath(app.getPath("userData"))
        }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(async () => {
    config = loadConfig();
    buildMenu();
    let root = config.lastRoot && fs.existsSync(config.lastRoot) ? config.lastRoot : null;
    if (!root) root = await chooseFolder();
    if (!root) {
      app.quit();
      return;
    }
    try {
      await openProject(root);
    } catch (error) {
      dialog.showErrorBox("GAP IDE could not start", String(error));
      app.quit();
    }
  });

  app.on("window-all-closed", () => {
    app.quit();
  });

  app.on("will-quit", (event) => {
    if (!server) return;
    event.preventDefault();
    const closing = server;
    server = null;
    void closing.close().finally(() => app.quit());
  });
}
