// Svelte's compiler options for every component and `.svelte.ts` module: runes mode for Kea's own files; a
// library under node_modules keeps the mode it was written in. Read by vite-plugin-svelte (app/renderer/vite.config.ts,
// the Vitest unit project) and by svelte-check (`pnpm typecheck`).
// TypeScript in `<script lang="ts">` is only stripped (no preprocessor): it must be erasable, as everywhere in Kea.
export default {
  compilerOptions: {
    /** @param {{ filename?: string }} file */
    runes: ({ filename }) => (filename?.split(/[/\\]/).includes('node_modules') ? undefined : true),
  },
}
