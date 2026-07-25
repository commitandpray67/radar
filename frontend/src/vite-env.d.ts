/// <reference types="vite/client" />

// Vite `?url` asset imports (e.g. the demoparser2 WASM + glue).
declare module '*?url' {
  const url: string;
  export default url;
}
