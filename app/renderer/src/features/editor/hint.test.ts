import { describe, expect, it } from 'vitest'
import { darwin } from '@kea/protocol/os/darwin'
import { linux } from '@kea/protocol/os/linux'
import { editorHint } from './hint.ts'

describe('the open-in-editor hint', () => {
  it('U-PLT-61 · with no editor found it names the machine as the system does; with the configured one missing it names that editor; with the default there it says nothing', () => {
    expect(editorHint({ hasDefault: false, found: 0, configured: 'VS Code' }, darwin.words)).toBe('No editor was found on this Mac')
    expect(editorHint({ hasDefault: false, found: 0, configured: 'VS Code' }, linux.words)).toBe('No editor was found on this computer')
    expect(editorHint({ hasDefault: false, found: 2, configured: 'VS Code' }, linux.words)).toBe('VS Code is not installed')
    expect(editorHint({ hasDefault: true, found: 2, configured: 'VS Code' }, linux.words)).toBe('')
  })
})
