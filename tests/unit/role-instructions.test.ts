import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { roleInstructions, roleResultInstructions } from '../../src/roles/instructions.js'
import { implementationSchema, reviewSchema, diagnosticSchema } from '../../src/workflow/types.js'

describe('host-assigned role instructions', () => {
  it.each([implementationSchema, reviewSchema, diagnosticSchema])('distinguishes result JSON from its schema and forbids metadata/fences %#', schema => {
    const text = roleResultInstructions(schema)
    expect(text).toContain('a result instance matching the schema below, not the schema document itself')
    expect(text).toContain('do not include extra fields or schema metadata such as $schema')
    expect(text).toContain('Do not use markdown fences or text outside the JSON object')
    const displayed = JSON.parse(text.split('\n').at(-1)!)
    const original = z.toJSONSchema(schema)
    const expected = { ...original }
    delete expected.$schema
    expect(displayed).toEqual(expected)
    expect(original.$schema).toBeDefined()
    expect(z.toJSONSchema(schema)).toEqual(original)
  })
  it('removes only root $schema and retains other root/nested schema metadata', () => {
    const schema = z.strictObject({ value: z.string().meta({ $schema: 'nested-dialect', $id: 'nested-id', title: 'Value' }) })
      .meta({ $id: 'root-id', title: 'Result', description: 'Allowed fields' })
    const displayed = JSON.parse(roleResultInstructions(schema).split('\n').at(-1)!)
    expect(displayed).not.toHaveProperty('$schema')
    expect(displayed).toMatchObject({ $id: 'root-id', title: 'Result', description: 'Allowed fields', additionalProperties: false,
      properties: { value: { $schema: 'nested-dialect', $id: 'nested-id', title: 'Value', type: 'string' } } })
    expect(schema.safeParse({ value: 'lawful', $schema: 'copied' }).success).toBe(false)
  })
  it('limits diagnosis to file inspection and prohibits pwsh probes and alternate entry points', () => {
    const text = roleInstructions('diagnostic')
    expect(text).toContain('Use only read, glob and grep')
    expect(text).toContain('Do not call or probe process, write, team or role-spawning tools, including pwsh')
    expect(text).toContain('Do not execute tests')
    expect(text).toContain('unverified items')
    expect(text).toContain('A tool refusal is not permission to try another entry point')
  })
  it('prohibits verification substitution and acceptance claims after confinement failure', () => {
    const text = roleInstructions('implementation')
    expect(text).toContain('exact approved verification commands')
     expect(text).toContain('problems: [] and limitations: []')
    expect(text).toContain('Do not silently change argv, add --test-isolation=none, widen confinement, retry through another entry point')
    expect(text).toContain('replace required checks with an assertion script')
    expect(text).toContain('leave that acceptance criterion unverified')
    expect(text).toContain('writer-reported observations, not host acceptance evidence or independent review')
    expect(text).toContain('Never claim an acceptance criterion is satisfied in substance')
  })
  it('requires review to use host evidence rather than writer claims or substituted commands', () => {
    const text = roleInstructions('review')
    expect(text).toContain('immutable snapshot and its host verification evidence')
    expect(text).toContain('writer-reported navigation aids, not independent proof')
    expect(text).toContain('Do not edit files, run processes or substitute your own command')
    expect(text).toContain('mark affected acceptance criteria unverified and do not return Passed')
    expect(text).toContain('file digests alone do not establish that these checks ran or passed')
    expect(text).toContain('checked lists concrete verified task facts')
    expect(text).toContain('unchecked lists remaining REQUIRED acceptance or scope uncertainty')
    expect(text).toContain('never move actual required uncertainty into reason to manufacture Passed')
    expect(text).toContain('unchecked empty and no blocking findings')
    expect(text).toContain('every criterion may legitimately be Inconclusive with empty evidence')
  })
  it('records the complete review instruction presented to the model', () => {
    expect(roleInstructions('review')).toMatchInlineSnapshot(`"Review only the supplied immutable snapshot and its host verification evidence. Implementation summaries and auxiliary checks are writer-reported navigation aids, not independent proof. Do not edit files, run processes or substitute your own command. Use actual host observations supplied in the logged task inputs for snapshot integrity and original-workspace inventory/scope checks; file digests alone do not establish that these checks ran or passed. checked lists concrete verified task facts. unchecked lists remaining REQUIRED acceptance or scope uncertainty, not optional extra checks or general limitations. Put out-of-scope checks and general limitations in reason; never move actual required uncertainty into reason to manufacture Passed. Include every approved acceptance ID exactly once with its actual status. A Passed criterion needs snapshot source evidence or a matching successful approved host check. Passed requires every criterion Passed with evidence, unchecked empty and no blocking findings. If required evidence is absent or failed, mark affected acceptance criteria unverified and do not return Passed. Return Inconclusive when required evidence or information is unavailable; every criterion may legitimately be Inconclusive with empty evidence. Do not demand independent rehashing, original-workspace enumeration or other Node versions unless the approved task requires them; use the supplied actual host observations without inferring verification from digests."`)
  })
})
