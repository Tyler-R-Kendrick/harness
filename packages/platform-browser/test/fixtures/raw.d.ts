// Vite's ?raw imports: a module's source, as text.
declare module "*?raw" {
  const source: string;
  export default source;
}

// Imports through factoryImports (@harness/platform-browser/vite): a function that runs the module again.
declare module "*?factory" {
  const factory: () => unknown;
  export default factory;
}
