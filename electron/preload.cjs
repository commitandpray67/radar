"use strict";

// Minimal preload — context isolation is ON, nodeIntegration is OFF.
// Nothing is exposed to the renderer; the React app communicates with the
// backend over plain HTTP on localhost, so no IPC bridge is needed.
