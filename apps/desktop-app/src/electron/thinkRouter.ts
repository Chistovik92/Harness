/**
 * Splits a leading `<think>…</think>` block out of a model's streamed answer.
 * Chat wrappers without reasoning support (ChatML, generic) leave the tags in
 * the text stream; this routes the reasoning to `emitThought` and the answer to
 * `emitText`, handling tags that arrive split across chunks.
 */

const OPEN = '<think>'
const CLOSE = '</think>'

export function createThinkRouter(emitText: (text: string) => void, emitThought: (text: string) => void) {
  let mode: 'start' | 'thought' | 'answer' = 'start'
  let buffer = ''

  const push = (chunk: string) => {
    if (mode === 'answer') { emitText(chunk); return }
    buffer += chunk
    if (mode === 'start') {
      const head = buffer.trimStart()
      // The opening tag may not be complete yet.
      if (head.length < OPEN.length && OPEN.startsWith(head)) return
      if (!head.startsWith(OPEN)) { mode = 'answer'; const out = buffer; buffer = ''; emitText(out); return }
      mode = 'thought'
      buffer = head.slice(OPEN.length)
    }
    const end = buffer.indexOf(CLOSE)
    if (end >= 0) {
      const thought = buffer.slice(0, end)
      const rest = buffer.slice(end + CLOSE.length)
      buffer = ''
      mode = 'answer'
      if (thought.trim()) emitThought(thought)
      if (rest) emitText(rest)
      return
    }
    // Hold back a tail: the closing tag may be split across chunks.
    const keep = CLOSE.length - 1
    if (buffer.length > keep) {
      emitThought(buffer.slice(0, buffer.length - keep))
      buffer = buffer.slice(buffer.length - keep)
    }
  }

  /** Call when generation ends so held-back text is not lost. */
  const flush = () => {
    if (!buffer) return
    if (mode === 'thought') emitThought(buffer)
    else emitText(buffer)
    buffer = ''
  }

  return { push, flush }
}
