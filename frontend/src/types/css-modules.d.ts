// Allow TypeScript to import CSS Modules
declare module '*.module.css' {
  const classes: Record<string, string>;
  export default classes;
}
