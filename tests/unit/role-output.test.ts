import { describe, expect, it } from 'vitest'
import type { ContentBlock, ToolCallId } from '@deepseek-ai/dsh-llm'
import { RoleResultError, parseRoleResult, roleOutputText } from '../../src/roles/output.js'
import { implementationSchema, diagnosticSchema, reviewSchema } from '../../src/workflow/types.js'
import { passed } from '../fixtures/workflow.js'

const thinking: ContentBlock = { type: 'reasoning', text: 'metadata that is not result evidence' }
const answer = (text: string): ContentBlock => ({ type: 'text', text })
describe('strict final role text with separate reasoning metadata', () => {
  it.each([
    { schema: implementationSchema, value: { outcome: 'Completed', summary: 'implemented', problems: [], limitations: [] } },
    { schema: reviewSchema, value: passed },
    { schema: diagnosticSchema, value: { summary: 'investigated', findings: [], limitations: ['not executed'] } },
  ])('returns schema-valid JSON text without reasoning', ({ schema, value }) => {
    const text = JSON.stringify(value), cut = Math.floor(text.length / 2)
    expect(schema.parse(JSON.parse(roleOutputText([thinking, answer(text.slice(0, cut)), answer(text.slice(cut))], Buffer.byteLength(text))))).toEqual(value)
  })
  it.each([undefined, [], [thinking], [thinking, answer('   ')]])('rejects missing final text %#', blocks => {
    expect(() => roleOutputText(blocks, 100)).toThrow('missing JSON text')
  })
  it.each<ContentBlock>([
    { type: 'tool-call', id: 'fixture-call' as ToolCallId, name: 'read', arguments: '{}' },
    { type: 'tool-addition', toolName: 'read' },
    { type: 'image', attachment: { attachmentId: 'fixture-image' as Extract<ContentBlock, { type: 'image' }>['attachment']['attachmentId'], mediaType: 'image/png', bytes: 1, width: 1, height: 1 } },
  ])('rejects $type even beside valid JSON', block => {
    expect(() => roleOutputText([thinking, answer('{}'), block], 100)).toThrow('unsupported output block')
  })
  it('applies a complete UTF-8 byte limit, including all text chunks', () => {
    const text = JSON.stringify({ summary: '诊断' }), bytes = Buffer.byteLength(text, 'utf8')
    expect(roleOutputText([thinking, answer(text)], bytes)).toBe(text)
    expect(() => roleOutputText([thinking, answer(text.slice(0, 2)), answer(text.slice(2))], bytes - 1)).toThrow('byte limit')
  })
  it.each(['not JSON', '```json\n{}\n```', '{} {}', '{} trailing'])('does not repair malformed JSON %s', text => {
    expect(() => JSON.parse(roleOutputText([thinking, answer(text)], 100))).toThrow()
  })
  it('keeps classified role-schema rejection after reasoning filtering', () => {
    expect(() => parseRoleResult(roleOutputText([thinking, answer('{}')], 100), diagnosticSchema, { role: 'diagnostic', runId: 'fixture-run' })).toThrow(RoleResultError)
  })
  it('retains split lawful text and UTF-8 limits through classified parsing', () => {
    const value = { summary: '诊断', findings: [], limitations: [] }, text = JSON.stringify(value), bytes = Buffer.byteLength(text, 'utf8')
    const blocks = [thinking, answer(text.slice(0, 10)), answer(text.slice(10))]
    expect(parseRoleResult(roleOutputText(blocks, bytes), diagnosticSchema, { role: 'diagnostic', runId: 'fixture-run' })).toEqual(value)
    expect(() => parseRoleResult(roleOutputText(blocks, bytes - 1), diagnosticSchema, { role: 'diagnostic', runId: 'fixture-run' })).toThrow('byte limit')
  })
})
