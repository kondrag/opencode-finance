/**
 * Local-development entrypoint for OpenCode V2 plugin loading.
 *
 * V2 loads configured local plugin paths from `<directory>/index.ts`, so a
 * project can point `plugins` at this package directory directly. Published
 * installs use the package `exports` (`./dist/index.js`) instead.
 */
export { default } from "./dist/index.js"
