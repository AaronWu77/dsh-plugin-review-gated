/** Stable role instructions; executor permissions and host verification remain the authority. */
import { z } from 'zod'
import type { Role } from '../security/permissions.js'

/** Select task-relevant role boundaries without broadening tools or interpreting model text as evidence.
 * @param role Host-assigned role, never selected by model output.
 * @returns Task instructions included in the role's logged first user message.
 */
export function roleInstructions(role: Exclude<Role, 'main'>): string {
  if (role === 'diagnostic') return 'Use only read, glob and grep. Do not call or probe process, write, team or role-spawning tools, including pwsh. Do not execute tests. Separate inspected file facts from inferred runtime behavior and unverified items. A tool refusal is not permission to try another entry point.'
  if (role === 'implementation') return 'Implement only the approved brief. Return a Completed result with every required field, including problems: [] and limitations: [], when there are no problems or limitations; never omit those arrays. The host runs the exact approved verification commands against the captured snapshot and decides check success. Do not silently change argv, add --test-isolation=none, widen confinement, retry through another entry point, or replace required checks with an assertion script. If confinement denies a required command, report the original command and error and leave that acceptance criterion unverified. Auxiliary checks are writer-reported observations, not host acceptance evidence or independent review. Never claim an acceptance criterion is satisfied in substance when its required verification did not succeed.'
  return 'Review only the supplied immutable snapshot and its host verification evidence. Implementation summaries and auxiliary checks are writer-reported navigation aids, not independent proof. Do not edit files, run processes or substitute your own command. Use actual host observations supplied in the logged task inputs for snapshot integrity and original-workspace inventory/scope checks; file digests alone do not establish that these checks ran or passed. checked lists concrete verified task facts. unchecked lists remaining REQUIRED acceptance or scope uncertainty, not optional extra checks or general limitations. Put out-of-scope checks and general limitations in reason; never move actual required uncertainty into reason to manufacture Passed. Include every approved acceptance ID exactly once with its actual status. A Passed criterion needs snapshot source evidence or a matching successful approved host check. Passed requires every criterion Passed with evidence, unchecked empty and no blocking findings. If required evidence is absent or failed, mark affected acceptance criteria unverified and do not return Passed. Return Inconclusive when required evidence or information is unavailable; every criterion may legitimately be Inconclusive with empty evidence. Do not demand independent rehashing, original-workspace enumeration or other Node versions unless the approved task requires them; use the supplied actual host observations without inferring verification from digests.'
}

/** Describe a result instance using a schema document without its root dialect metadata.
 * @param schema Unmodified validator for the returned role result.
 * @returns Output instructions and schema for the logged first user task message.
 */
export function roleResultInstructions(schema: z.ZodType): string {
  const { $schema: dialect, ...document } = z.toJSONSchema(schema)
  return 'Return a single JSON object that is a result instance matching the schema below, not the schema document itself. '
    + 'Return only result fields; do not include extra fields or schema metadata such as $schema, $id, title, type, properties, required or additionalProperties. '
    + 'Do not use markdown fences or text outside the JSON object.\nResult JSON schema (describes allowed result fields; do not copy this document):\n'
    + JSON.stringify(document)
}
