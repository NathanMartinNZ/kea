import { L } from '@kea/protocol'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AnswerWait, BROWSER_DID_NOT_ANSWER } from './answerWait.ts'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('answerWait', () => {
  it("U-FV-42 · the window's wait: an answer in time gives its words; none by the deadline gives the browser did not answer; a late answer is dropped; a newer request replaces an older one", async () => {
    const wait = new AnswerWait(L.browserAnswerDeadlineMs, BROWSER_DID_NOT_ANSWER)

    // in time: main's words, or null once handed over
    const failed = wait.begin(1)
    vi.advanceTimersByTime(L.browserAnswerDeadlineMs - 1)
    wait.answer(1, 'No default browser was found')
    expect(await failed).toBe('No default browser was found')
    const handed = wait.begin(2)
    wait.answer(2, null)
    expect(await handed).toBeNull()
    expect(wait.waiting).toBe(false)

    // no answer by the deadline; the late one is dropped
    const silent = wait.begin(3)
    vi.advanceTimersByTime(L.browserAnswerDeadlineMs)
    expect(await silent).toBe(BROWSER_DID_NOT_ANSWER)
    expect(wait.waiting).toBe(false)
    wait.answer(3, 'too late')
    expect(vi.getTimerCount()).toBe(0)

    // a newer request ends the older one with no words; the older one's answer is dropped, the newer one's taken
    const older = wait.begin(4)
    const newer = wait.begin(5)
    expect(await older).toBeNull()
    wait.answer(4, 'for the replaced request')
    expect(wait.waiting).toBe(true)
    wait.answer(5, 'The page could not be opened')
    expect(await newer).toBe('The page could not be opened')
    expect(vi.getTimerCount()).toBe(0)
  })
})
