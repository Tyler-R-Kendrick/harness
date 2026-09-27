/** A stylesheet imported as text (Vite's `?inline`), for the page to put in a `<style>`. */
declare module "*?inline" {
  const css: string;
  export default css;
}
