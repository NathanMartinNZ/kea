// The pages of the Settings sheet, in its order: the five sections generated from the settings schema (General,
// Terminal, Agents, Notifications, Files), then the custom pages (Keyboard, Projects, Disk, Advanced, About).
// `Settings.svelte` lists them on the left and mounts the selected one on the right. A feature that owns a page puts
// its component here (Disk is the disk feature's: features/disk).

import type { Component } from 'svelte'
import DiskPage from '../disk/DiskPage.svelte'
import AboutPage from './AboutPage.svelte'
import AdvancedPage from './AdvancedPage.svelte'
import AgentsPage from './AgentsPage.svelte'
import KeyboardPage from './KeyboardPage.svelte'
import NotificationsPage from './NotificationsPage.svelte'
import ProjectsPage from './ProjectsPage.svelte'
import SectionPage from './SectionPage.svelte'
import TerminalPage from './TerminalPage.svelte'

export interface SettingsPage {
  /** What `app.settings` takes as `{ page }` and the sheet remembers. */
  id: string
  /** Its name in the list. */
  title: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- each page declares its own props
  component: Component<any>
  /** Props the page is mounted with, beside `projectId` (the project `project.settings` picked; a page that has no use for it ignores it). */
  props?: Readonly<Record<string, unknown>>
}

export const SETTINGS_PAGES: readonly SettingsPage[] = [
  { id: 'general', title: 'General', component: SectionPage, props: { section: 'General' } },
  { id: 'terminal', title: 'Terminal', component: TerminalPage },
  { id: 'agents', title: 'Agents', component: AgentsPage },
  { id: 'notifications', title: 'Notifications', component: NotificationsPage },
  { id: 'files', title: 'Files', component: SectionPage, props: { section: 'Files' } },
  { id: 'keyboard', title: 'Keyboard', component: KeyboardPage },
  { id: 'projects', title: 'Projects', component: ProjectsPage },
  { id: 'disk', title: 'Disk', component: DiskPage },
  { id: 'advanced', title: 'Advanced', component: AdvancedPage },
  { id: 'about', title: 'About', component: AboutPage },
]

/** The page with this id; an id no page has is the first page. */
export function pageOf(id: string): SettingsPage {
  return SETTINGS_PAGES.find((p) => p.id === id) ?? SETTINGS_PAGES[0]!
}
