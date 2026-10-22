// The package.json a build of Kea carries (tools/build.ts writes it into dist/app). `desktopName` is Electron's app
// id on Linux: the Wayland app id, the X11 window class and the desktop file a notification names. A
// build here is a dev build, with its own id; a package sets the packaged one (config.ts).
import { DESKTOP_IDS } from '../../../packages/protocol/src/platform.ts'

export function appPackageJson(version: string): Record<string, unknown> {
  return { name: 'kea', productName: 'Kea', version, main: 'main.cjs', private: true, desktopName: `${DESKTOP_IDS.dev}.desktop` }
}
