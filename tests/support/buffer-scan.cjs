// A search of one JavaScript process's binary memory for marker strings, which checks that file contents and terminal
// chunks are dropped after use. A heap snapshot lists JavaScript strings, but not what typed arrays hold, and
// that is where terminal output lives: PTY chunks are byte buffers, and xterm keeps a line as 32-bit cells. So this
// looks through the buffers alive, each whole (a small typed array holds its bytes inside the object until its buffer
// is asked for, and a pooled Buffer's slab is found whole, whichever part its views show).
//
// Which buffers: in core and ptyhost (the test hook, app-child-hooks.cjs, op `scan`, through an in-process inspector
// session) every ArrayBuffer and every typed array alive, as `Runtime.queryObjects` finds them by prototype. In the
// window that query answers with none of them (Blink's inspector leaves out objects with unset embedder fields, which
// every ArrayBuffer and typed array has), so there `collectBuffers` first gathers them from every ordinary object
// alive: each one that is the value of an own property, an element of an array, or a key or value of a Map or Set
// (tests/memory/app-markers.test.ts runs both functions over CDP, from their source: so they are self-contained).
// A needle arrives as its character codes, never as a string, so looking for a marker does not put the marker into
// the heap being searched.
//
// A WebAssembly memory is binary memory too, and no object holds its buffer as a property (it is behind a getter):
// `memoryBuffers` takes the buffer of every `WebAssembly.Memory` alive (`Runtime.queryObjects` by `MEMORIES`), for
// `scanBuffers` to search with the rest. The highlight worker's Oniguruma heap is one.
//
// The window also holds text where neither a heap snapshot nor a buffer shows it: in the DOM itself. A text node's
// characters, a form control's value and an attribute's value live in Blink, not in V8, and a subtree that was taken
// out of the document stays alive for as long as JavaScript holds one node of it (a closed tab's frame kept by a
// listener is this kind of leak: @codemirror/view keeps scroll listeners on an editor's old ancestors).
// `scanDom` reads them: the document, and every tree that a node JavaScript holds belongs to (`Runtime.queryObjects` by
// `NODES`), attached or not.
//
// Each function searches the JavaScript world it is run in (the page's own, the preload's isolated one, a worker's):
// `Runtime.queryObjects` answers by a prototype, and every world has its own.
//
// What they cannot see: memory no ArrayBuffer wraps other than the DOM's text (native allocations such as SQLite's
// page cache, GPU textures, the compositor's layers, messages in transit between processes), a 16-bit or 32-bit form
// that does not start on a multiple of its width from the buffer's start, in the window and a worker a buffer that
// only a closure, a private `#field` or a WeakMap holds, and a detached DOM tree no JavaScript object refers to (one
// only Blink itself still holds: a node being painted, an undo stack's).
'use strict'

/**
 * `this` and `more`: arrays of ArrayBuffers and typed arrays (a typed array stands for its whole buffer); `needles`:
 * each marker as an array of its character codes. Answers `{ buffers, bytes, found }`, `found[i]` listing where needle
 * `i` was seen: `as` is `bytes` (one byte a character: UTF-8, Latin-1), `utf16`, `cells` (xterm's line: three 32-bit
 * words a cell, the code point in the low 21 bits of the first) or `words` (one 32-bit word a character), and `size`
 * the buffer's length.
 */
function scanBuffers(more, needles) {
  const seen = new Set() // bounded: one entry per buffer alive, for the length of this call
  const all = []
  const add = (x) => {
    let b
    try {
      b = ArrayBuffer.isView(x) ? x.buffer : x
    } catch (e) {
      return // a view whose buffer cannot be read holds nothing to find
    }
    if (b && !seen.has(b)) {
      seen.add(b)
      all.push(b)
    }
  }
  for (let i = 0; i < this.length; i++) add(this[i])
  for (let i = 0; i < more.length; i++) add(more[i])
  /** Is the needle at `at`, one character every `stride` elements, each element's low bits (`mask`) its code? */
  const here = (arr, at, codes, stride, mask) => {
    if (at + (codes.length - 1) * stride >= arr.length) return false
    for (let k = 1; k < codes.length; k++) if ((arr[at + k * stride] & mask) !== codes[k]) return false
    return true
  }
  /** `first`: the first character as the array stores it (xterm sets a cell's width above the code point). */
  const find = (arr, codes, stride, first, mask) => {
    for (let at = arr.indexOf(first); at !== -1; at = arr.indexOf(first, at + 1)) if (here(arr, at, codes, stride, mask)) return true
    return false
  }
  const CODE_POINT = 0x1fffff
  const WIDTH_ONE = 1 << 22
  const found = needles.map(() => [])
  let bytes = 0
  let buffers = 0
  for (const b of all) {
    let u8
    try {
      u8 = new Uint8Array(b)
    } catch (e) {
      continue // detached
    }
    if (u8.length === 0) continue
    buffers++
    bytes += u8.length
    const u16 = u8.length >= 2 ? new Uint16Array(b, 0, u8.length >> 1) : null
    const u32 = u8.length >= 4 ? new Uint32Array(b, 0, u8.length >> 2) : null
    for (let n = 0; n < needles.length; n++) {
      const codes = needles[n]
      let as = null
      if (find(u8, codes, 1, codes[0], 0xff)) as = 'bytes'
      else if (u16 && find(u16, codes, 1, codes[0], 0xffff)) as = 'utf16'
      else if (u32 && (find(u32, codes, 3, codes[0] | WIDTH_ONE, CODE_POINT) || find(u32, codes, 3, codes[0], CODE_POINT))) as = 'cells'
      else if (u32 && find(u32, codes, 1, codes[0], CODE_POINT)) as = 'words'
      if (as) found[n].push({ as, size: u8.length })
    }
  }
  return { buffers, bytes, found }
}

/**
 * `this`: an array of every ordinary object alive (`Runtime.queryObjects` by `Object.prototype`). Answers an array of
 * the ArrayBuffers and typed arrays they hold: as the value of an own property (never through a getter), as an element
 * of an array, or as a key or value of a Map or Set.
 */
function collectBuffers() {
  const out = new Set() // bounded: one entry per buffer or view found, for the length of this call
  const shared = typeof SharedArrayBuffer === 'function' ? SharedArrayBuffer : null
  const take = (v) => {
    if (v !== null && typeof v === 'object' && (ArrayBuffer.isView(v) || v instanceof ArrayBuffer || (shared !== null && v instanceof shared))) out.add(v)
  }
  for (let i = 0; i < this.length; i++) {
    const o = this[i]
    try {
      if (Array.isArray(o)) {
        // a sparse array's holes are skipped
        o.forEach(take)
      } else if (o instanceof Map) {
        for (const [k, v] of o) {
          take(k)
          take(v)
        }
      } else if (o instanceof Set) {
        for (const v of o) take(v)
      }
      for (const k of Reflect.ownKeys(o)) {
        const d = Object.getOwnPropertyDescriptor(o, k)
        if (d && 'value' in d) take(d.value)
      }
    } catch (e) {
      // an object that refuses to be looked at (a proxy whose trap throws) is passed over
    }
  }
  return [...out]
}

/** `this`: an array of every `WebAssembly.Memory` alive. Answers their buffers. */
function memoryBuffers() {
  const out = []
  for (let i = 0; i < this.length; i++) {
    try {
      out.push(this[i].buffer)
    } catch (e) {
      // a memory that cannot be read holds nothing to find
    }
  }
  return out
}

/**
 * `this`: an array of every DOM node JavaScript holds (`Runtime.queryObjects` by `Node.prototype`); `needles`: each
 * marker as an array of its character codes. Searches the document and every tree one of those nodes belongs to,
 * attached or not: the text of each text, CDATA and comment node, the value of each form control, every attribute's
 * value, and the same below each open shadow root, template content and same-origin frame document. Answers
 * `{ nodes, trees, detached, chars, found }`: how many nodes were handed over, how many trees were walked and how many
 * of them hang in no document, the characters read, and per needle where it was seen (`where`: `document` or
 * `detached`; `in`: `text`, `value` or `attribute`; `node`: the node's name), at most MAX_HITS each.
 */
function scanDom(needles) {
  const MAX_HITS = 20
  const has = (text, codes) => {
    const first = String.fromCharCode(codes[0])
    for (let at = text.indexOf(first); at !== -1; at = text.indexOf(first, at + 1)) {
      let k = 1
      while (k < codes.length && text.charCodeAt(at + k) === codes[k]) k++
      if (k === codes.length) return true
    }
    return false
  }
  const found = needles.map(() => [])
  const walked = new Set() // bounded: one entry per tree walked, for the length of this call
  let chars = 0
  let detached = 0
  const look = (text, where, what, node) => {
    if (typeof text !== 'string' || text.length === 0) return
    chars += text.length
    for (let n = 0; n < needles.length; n++) if (found[n].length < MAX_HITS && has(text, needles[n])) found[n].push({ where, in: what, node: node.nodeName })
  }
  const walk = (root, where) => {
    if (!root || walked.has(root)) return
    walked.add(root)
    const doc = root.nodeType === 9 ? root : root.ownerDocument
    if (!doc) return
    const all = doc.createTreeWalker(root, 0xffffffff)
    for (let node = root; node; node = all.nextNode()) {
      const type = node.nodeType
      if (type === 3 || type === 4 || type === 8) look(node.data, where, 'text', node)
      else if (type === 2) look(node.value, where, 'attribute', node)
      else if (type === 1) {
        for (const a of node.attributes) look(a.value, where, 'attribute', node)
        // a form control's value is not in its attributes once it was typed into or set
        if (typeof node.value === 'string') look(node.value, where, 'value', node)
        if (node.shadowRoot) walk(node.shadowRoot, where)
        if (node.content && node.content.nodeType === 11) walk(node.content, where)
        let inner = null
        try {
          inner = node.contentDocument || null
        } catch (e) {
          // another origin's frame
        }
        if (inner) walk(inner, where)
      }
    }
  }
  if (typeof document === 'object' && document) walk(document, 'document')
  for (let i = 0; i < this.length; i++) {
    try {
      // an attribute is no part of a tree: its element stands for it (one that belongs to no element is its own tree)
      const node = this[i].nodeType === 2 && this[i].ownerElement ? this[i].ownerElement : this[i]
      const root = node.getRootNode({ composed: true })
      if (walked.has(root)) continue
      const attached = root.nodeType === 9 && root.defaultView !== null
      if (!attached) detached++
      walk(root, attached ? 'document' : 'detached')
    } catch (e) {
      // a node that refuses to be looked at is passed over
    }
  }
  return { nodes: this.length, trees: walked.size, detached, chars, found }
}

/**
 * The expressions whose values `Runtime.queryObjects` takes as prototypes: every ArrayBuffer, typed array, object,
 * WebAssembly memory and DOM node.
 */
const BUFFERS = 'ArrayBuffer.prototype'
const VIEWS = 'Object.getPrototypeOf(Uint8Array.prototype)'
const OBJECTS = 'Object.prototype'
const MEMORIES = 'WebAssembly.Memory.prototype'
const NODES = 'Node.prototype'

module.exports = { scanBuffers, collectBuffers, memoryBuffers, scanDom, BUFFERS, VIEWS, OBJECTS, MEMORIES, NODES }
