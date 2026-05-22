"use strict";

const { app, BrowserWindow, Menu, shell, dialog } = require("electron");
const { spawn } = require("child_process");
const path = require("path");
const http = require("http");

const isDev = !app.isPackaged;
let backend = null;
let backendPort = null;
let logsDir = app.getPath("logs"); // fallback until backend reports its log dir

// ---------------------------------------------------------------------------
// Backend process management
// ---------------------------------------------------------------------------

function backendBinary() {
  const serverDir = isDev
    ? path.resolve(__dirname, "..", "backend", "dist", "radar-server")
    : path.join(process.resourcesPath, "radar-server");
  const exe = process.platform === "win32" ? "radar-server.exe" : "radar-server";
  return path.join(serverDir, exe);
}

function startBackend() {
  return new Promise((resolve, reject) => {
    const bin = backendBinary();
    backend = spawn(bin, [], { stdio: ["ignore", "pipe", "pipe"] });

    let portResolved = false;

    backend.stdout.on("data", (buf) => {
      const text = buf.toString();
      process.stdout.write(`[backend] ${text}`);

      const pm = text.match(/PORT=(\d+)/);
      if (pm && !portResolved) {
        portResolved = true;
        backendPort = Number(pm[1]);
        waitForHealth(backendPort).then(resolve).catch(reject);
      }

      const lm = text.match(/LOGS_DIR=(.+)/);
      if (lm) {
        logsDir = lm[1].trim();
        buildMenu(logsDir);
      }
    });

    backend.stderr.on("data", (buf) => {
      process.stderr.write(`[backend] ${buf}`);
    });

    backend.on("exit", (code) => {
      if (!portResolved) {
        reject(new Error(`Backend exited before becoming ready (exit code ${code})`));
      }
    });
  });
}

function waitForHealth(port, attempts = 60) {
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get(`http://127.0.0.1:${port}/api/health`, (res) => {
        res.resume();
        if (res.statusCode === 200) return resolve();
        retry();
      });
      req.on("error", retry);
      req.setTimeout(500, () => { req.destroy(); retry(); });
    };
    const retry = () => {
      if (--attempts <= 0) {
        return reject(new Error("Backend did not become healthy in time"));
      }
      setTimeout(tick, 300);
    };
    tick();
  });
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

async function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: "#1a1a1a",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.once("ready-to-show", () => win.show());

  // Open external links in the OS browser, not inside Electron
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  await win.loadURL(`http://127.0.0.1:${backendPort}`);
}

// ---------------------------------------------------------------------------
// Application menu
// ---------------------------------------------------------------------------

function buildMenu(logsDirPath) {
  const template = [
    ...(process.platform === "darwin" ? [{ role: "appMenu" }] : []),
    { role: "fileMenu" },
    { role: "editMenu" },
    { role: "viewMenu" },
    {
      label: "Help",
      submenu: [
        {
          label: "Open Logs Folder",
          click: () => shell.openPath(logsDirPath),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

app.whenReady().then(async () => {
  buildMenu(logsDir); // set initial menu before backend starts

  try {
    await startBackend();
    await createWindow();
  } catch (err) {
    dialog.showErrorBox(
      "CS2 Radar — Failed to Start",
      `The server could not be started.\n\n${err.message}\n\nLogs are in:\n${logsDir}`
    );
    app.quit();
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", async () => {
  const { BrowserWindow: BW } = require("electron");
  if (BW.getAllWindows().length === 0 && backendPort) {
    await createWindow();
  }
});

app.on("before-quit", () => {
  if (backend && !backend.killed) {
    backend.kill(); // SIGTERM on Unix, TerminateProcess on Windows
  }
});
