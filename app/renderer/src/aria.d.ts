// `aria-description` (ARIA 1.3) is missing from Svelte's element types; Chromium exposes it as the accessible
// description, and the sidebar rows use it. A module augmentation, so the file must be a module.
export {}

declare module 'svelte/elements' {
  interface AriaAttributes {
    'aria-description'?: string | undefined | null
  }
}
