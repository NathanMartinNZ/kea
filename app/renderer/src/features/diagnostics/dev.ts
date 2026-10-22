// Whether this window's code was built for development. `tools/build.ts` builds the renderer with Vite's mode
// `production` only for a release (`pnpm kea:install`), and Vite replaces `import.meta.env.MODE` with the mode's name
// as it builds: in a release build `DEV_BUILD` is the constant false, and what it guards is left out of the bundle.
// The performance HUD is guarded by it everywhere, so a production build does not contain it.

export const DEV_BUILD: boolean = import.meta.env.MODE !== 'production'
