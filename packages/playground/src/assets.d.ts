/** A stylesheet imported as text (Vite's `?inline`), for the page to put in a `<style>`. */
declare module "*?inline" {
  const css: string;
  export default css;
}

/** A file imported as text (Vite's `?raw`): the settings and seed templates in data/. */
declare module "*?raw" {
  const text: string;
  export default text;
}
