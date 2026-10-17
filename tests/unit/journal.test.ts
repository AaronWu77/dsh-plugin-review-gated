import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type { Domain, KvTable } from '@deepseek-ai/dsh-storage-domain'
import { journalSchema, WorkflowJournals, workflowDomain } from '../../src/storage/journal.js'
import type { WorkflowJournal } from '../../src/storage/journal.js'
import { initialState, replay } from '../../src/workflow/controller.js'
import { readyEvents, snapshot } from '../fixtures/workflow.js'

const empty = { version: 1, sessionId: SessionId('fixture'), cwd: '/project', createdAt: 1, baseCommit: null, repository: null, records: [], state: initialState() }
describe('durable workflow journal parser', () => {
  it('validates an empty Session-associated journal', () => { expect(journalSchema.parse(empty)).toEqual(empty) })
  it('rejects a fabricated state without matching durable facts', () => {
    expect(() => journalSchema.parse({ ...empty, state: { ...empty.state, phase: 'Approved' } })).toThrow('disagrees')
  })
  it('rejects malformed, reordered, or future record versions', () => {
    expect(() => journalSchema.parse({ ...empty, records: [{ version: 2, event: readyEvents()[0] }] })).toThrow()
    expect(() => journalSchema.parse({ ...empty, records: [{ version: 1, event: readyEvents()[1] }] })).toThrow()
  })
  it('requires both repository and base when bound', () => {
    expect(() => journalSchema.parse({ ...empty, baseCommit: snapshot.baseCommit })).toThrow('Incomplete')
  })
  it('drains an in-flight Controller commit before closing the domain', async () => {
    const rows = new Map<SessionId, WorkflowJournal>(), sessionId = SessionId(randomUUID()), session = Session.create(sessionId, [], { version: SESSION_FORMAT_VERSION, id: sessionId, createdAt: 1, cwd: 'C:\\project', isSeeded: false })
    let blockWrites = false, releaseWrite!: () => void
    const writeGate = new Promise<void>(resolve => { releaseWrite = resolve })
    const table: KvTable<SessionId, WorkflowJournal> = {
      get: key => rows.get(key), entries: () => rows.entries(), keys: () => rows.keys(), get size() { return rows.size },
      put: async (key, value) => { if (blockWrites) await writeGate; rows.set(key, value) },
      delete: async key => rows.delete(key),
      update: async (key, update) => { const current = rows.get(key); if (!current) throw new Error('missing key'); const next = update(current); rows.set(key, next); return next },
    }
    let domainClosed = false
    const domain = { name: workflowDomain.name, global: undefined as never, table: () => table, close: async () => { domainClosed = true } } as Domain<typeof workflowDomain>
    const journals = new WorkflowJournals(domain, { maxRecords: 100, maxBytes: 1024 * 1024 })
    await journals.initialize(session)
    blockWrites = true
    const controller = journals.controller(session), append = controller.apply(readyEvents()[0]!)
    await Promise.resolve()
    let closeFinished = false
    const close = journals.close().then(() => { closeFinished = true })
    await Promise.resolve()
    expect(closeFinished).toBe(false)
    releaseWrite()
    await append
    await close
    expect(domainClosed).toBe(true)
    expect(rows.get(sessionId)?.records.map(record => record.event.type)).toEqual(['requirements-submitted'])
  })
  it('rejects a staged tree from a different bound base or repository', () => {
    const records = readyEvents().slice(0, 5).map(event => ({ version: 1, event }))
    const state = replay(records)
    expect(() => journalSchema.parse({ ...empty, records, state, baseCommit: 'f'.repeat(40), repository: '/project' })).toThrow('Snapshot disagrees')
    expect(() => journalSchema.parse({ ...empty, records, state, baseCommit: snapshot.baseCommit, repository: '/another' })).toThrow('Snapshot disagrees')
    expect(journalSchema.parse({ ...empty, records, state, baseCommit: snapshot.baseCommit, repository: snapshot.repository }).state.phase).toBe('Staged')
  })
})
