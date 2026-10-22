// The platform report's lines that read the same on both systems: the terminal renderer.
import { describe, expect, it } from 'vitest'
import { GPU_DRIVER_FIX, terminalRendererLine, webglState } from './platformLines.ts'

/**
 * `app.getGPUFeatureStatus()` as Electron 44 gives it: a Mac with its GPU, and a virtual machine without a GPU driver.
 * Neither has a `webgl2` key: Chromium names WebGL's state `webgl`, WebGL2's included.
 */
const MAC = { '2d_canvas': 'enabled', gpu_compositing: 'enabled', opengl: 'enabled_on', rasterization: 'enabled', skia_graphite: 'enabled_on', webgl: 'enabled', webgpu: 'enabled', webnn: 'disabled_off' }
const VM = { '2d_canvas': 'disabled_software', gpu_compositing: 'disabled_software', opengl: 'disabled_off', rasterization: 'disabled_software', vulkan: 'disabled_off', webgl: 'disabled_off', webgpu: 'disabled_off' }

describe('the terminal renderer line', () => {
  it('U-PLT-46 · read from Chromium’s GPU feature status as Electron gives it (WebGL’s state is `webgl`): a Mac with a GPU draws with WebGL and the line has no fix; a machine without a GPU driver gets xterm’s DOM renderer and the fix; a status with neither key is unknown', () => {
    expect(terminalRendererLine(webglState(MAC), GPU_DRIVER_FIX)).toEqual({ id: 'terminalRenderer', label: 'Terminal drawing', value: 'WebGL, on the GPU', fix: null })
    const vm = terminalRendererLine(webglState(VM), GPU_DRIVER_FIX)
    expect(vm.value).toContain("xterm's DOM renderer")
    expect(vm.value).toContain('(disabled_off)')
    expect(vm.fix).toMatch(/GPU driver/)
    // a Chromium that names WebGL2 apart is read by that name
    expect(webglState({ webgl: 'enabled', webgl2: 'unavailable_off' })).toBe('unavailable_off')
    expect(terminalRendererLine(webglState({}), GPU_DRIVER_FIX).value).toContain('(unknown)')
  })
})
