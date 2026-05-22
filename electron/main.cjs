"use strict";

const { app, BrowserWindow, Menu, shell, dialog } = require("electron");
const { spawn } = require("child_process");
const readline = require("readline");
const path = require("path");
const http = require("http");
const fs = require("fs");

// ---------------------------------------------------------------------------
// Single-instance enforcement
// Prevents two copies of the app running side-by-side (each would spawn its
// own backend, causing port conflicts and data races on the shared SQLite db).
// ---------------------------------------------------------------------------
const instanceLock = app.requestSingleInstanceLock();
if (!instanceLock) {
  app.quit();
  process.exit(0);
}
app.on("second-instance", () => {
  const [win] = BrowserWindow.getAllWindows();
  if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
});

const isDev = !app.isPackaged;
let backend = null;
let backendPort = null;
let logsDir = app.getPath("logs"); // overwritten once backend reports LOGS_DIR=
let cleanupRan = false;

// ---------------------------------------------------------------------------
// Backend cleanup — idempotent, safe to call from multiple exit paths
// ---------------------------------------------------------------------------
function killBackend() {
  if (cleanupRan) return;
  cleanupRan = true;
  if (backend && !backend.killed) {
    backend.kill("SIGTERM");
  }
}

// Cover all exit paths: normal quit, SIGTERM (e.g. systemd / macOS shutdown),
// and SIGINT (Ctrl-C during development).
app.on("quit", killBackend);
process.on("SIGTERM", () => { killBackend(); app.quit(); });
process.on("SIGINT",  () => { killBackend(); process.exit(0); });

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

    if (!fs.existsSync(bin)) {
      return reject(new Error(
        `Backend executable not found at:\n${bin}\n\nThe application may be corrupted. ` +
        `Try reinstalling.`
      ));
    }

    backend = spawn(bin, [], { stdio: ["ignore", "pipe", "pipe"] });

    let portResolved = false;

    // Process stdout line-by-line so partial TCP chunks never break the parser.
    const rl = readline.createInterface({ input: backend.stdout, crlfDelay: Infinity });
    rl.on("line", (line) => {
      process.stdout.write(`[backend] ${line}\n`);

      // Match exactly "PORT=<digits>" as a full line — anchor prevents matching
      // stray log output that happens to contain "PORT=".
      const pm = line.match(/^PORT=(\d+)$/);
      if (pm && !portResolved) {
        const p = Number(pm[1]);
        if (p > 0 && p < 65536) {
          portResolved = true;
          backendPort = p;
          clearTimeout(startupTimeout);
          waitForHealth(p).then(resolve).catch(reject);
        }
      }

      // Log directory reported by the backend — used in the Help menu and
      // in the error dialog so users know where to find their crash logs.
      const lm = line.match(/^LOGS_DIR=(.+)$/);
      if (lm) {
        logsDir = lm[1].trim();
        buildMenu(logsDir);
      }
    });

    backend.stderr.on("data", (buf) => {
      process.stderr.write(`[backend] ${buf}`);
    });

    backend.on("exit", (code, signal) => {
      if (!portResolved) {
        reject(new Error(
          `Backend process exited before reporting a port ` +
          `(exit code ${code ?? "—"}, signal ${signal ?? "—"}).`
        ));
      }
    });

    // If PORT= is not received within 15 s the backend likely failed to start.
    const startupTimeout = setTimeout(() => {
      if (!portResolved) {
        reject(new Error("Backend did not report a port within 15 seconds."));
        backend.kill();
      }
    }, 15_000);
    startupTimeout.unref(); // don't prevent Node exit if everything else is done
  });
}

// Poll /api/health until the backend is ready to serve requests.
// 80 attempts × 300 ms retry = 24 s total ceiling (covers slow first-launch
// cold-disk scenarios and occasional GC pauses during startup).
function waitForHealth(port, attempts = 80) {
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get(`http://127.0.0.1:${port}/api/health`, (res) => {
        res.resume(); // consume body so the socket is released
        if (res.statusCode === 200) return resolve();
        retry();
      });
      req.on("error", retry);
      // 1 s per attempt — generous enough to survive a GC pause, tight enough
      // that we don't stall the whole startup for too long.
      req.setTimeout(1_000, () => { req.destroy(); retry(); });
    };
    const retry = () => {
      if (--attempts <= 0) {
        return reject(new Error(
          "Backend started but did not respond to health checks within the timeout period."
        ));
      }
      setTimeout(tick, 300);
    };
    tick();
  });
}

// ---------------------------------------------------------------------------
// Browser window
// ---------------------------------------------------------------------------

async function createWindow() {
  if (!backendPort) {
    throw new Error("Internal error: attempted to create window before backend port was resolved.");
  }

  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: "#1a1a1a",
    show: false, // shown via ready-to-show to eliminate the white flash
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.once("ready-to-show", () => win.show());

  // Open external links (e.g. links in the UI) in the OS default browser,
  // not in a new Electron window.
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
          // Opens the folder in Finder / Explorer / Nautilus so users can
          // attach logs to a bug report without needing CLI skills.
          click: () => shell.openPath(logsDirPath),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

app.whenReady().then(async () => {
  buildMenu(logsDir); // initial menu before backend reports LOGS_DIR

  try {
    await startBackend();
    await createWindow();
  } catch (err) {
    dialog.showErrorBox(
      "CS2 Radar — Failed to Start",
      `The application could not start.\n\n${err.message}\n\nLogs are in:\n${logsDir}`
    );
    app.quit();
  }
});

app.on("window-all-closed", () => {
  // On macOS it's conventional to keep the app running even with no windows,
  // but we shut down fully because the backend process would be idle anyway.
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", async () => {
  // macOS: re-open window when the Dock icon is clicked and no window exists.
  if (BrowserWindow.getAllWindows().length === 0 && backendPort) {
    await createWindow();
  }
});
