/** Isolated browser geometry probe using built cards and an explicitly supplied DSH composer's DOM/CSS; not an active-GUI end-to-end test. */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { briefDetails, decisionCard, operationCard, recoveryDetails } from '../dist/workflow/interaction.js'
import { submittedBriefSchema } from '../dist/workflow/types.js'
import { initialState } from '../dist/workflow/controller.js'

const [directory, channel] = process.argv.slice(2).filter(value => value !== '--')
assert(directory, 'Supply the compatible DSH checkout; the browser probe never connects to an active GUI')
const checkout = resolve(directory)
const require = createRequire(join(checkout, 'apps/web/package.json'))
const { chromium } = require('playwright')
const css = await readFile(join(checkout, 'packages/client/ui-user-questions/src/client/QuestionComposer.module.css'), 'utf8')
const composer = await readFile(join(checkout, 'packages/client/ui-user-questions/src/client/QuestionComposer.tsx'), 'utf8')
assert(composer.includes('<h2 className={css.title}') && composer.includes('{question.question}') && composer.includes('{option.description}'), 'Reconcile the probe when the owning composer changes its title/body fields')
const brief = submittedBriefSchema.parse({ id: 'layout', revision: 1, executionIntent: 'implementation', goal: '实现导出功能并正确保留所有筛选条件。'.repeat(12),
  nonGoals: ['不修改鉴权'], allowedPaths: ['src', 'tests'], constraints: ['保持现有调用者兼容'],
  acceptanceCriteria: Array.from({ length: 10 }, (_, index) => ({ id: 'AC' + index, description: '对正常输入和边界输入进行正确处理，并保持现有行为与稳定的错误输出。'.repeat(4) })),
  verificationCommands: [{ executable: 'node', args: ['--test', '--test-isolation=none', 'test/add.test.js'], timeoutMs: 60000 }], maxRepairRounds: 2, executionBudgetMs: 180000, questions: [] })
const state = { ...initialState(), brief, phase: 'Ready for Handoff', approval: { questionId: 'approved', revision: 1, approved: true },
  snapshot: { id: 'candidate', treeId: 'b'.repeat(40), baseCommit: 'a'.repeat(40), changedPaths: ['src/export.ts'], repository: '/layout-input', briefRevision: 1 } }
const base = { revision: 1, binding: 'binding', phase: 'Awaiting Approval', askedAt: 1, afterSeq: -1, status: 'pending' }
const cards = [
  decisionCard({ ...base, id: 'approval', kind: 'approval', question: 'Approve this exact development brief?', detail: briefDetails(brief), options: [{ label: 'Approve' }, { label: 'Reject and revise' }] })[0],
  ...['execution', 'handoff'].map(kind => operationCard({ id: kind, kind, mode: kind === 'handoff' ? 'handoff' : 'implement-verify-review', revision: 1, binding: 'binding', askedAt: 1, afterSeq: -1, status: 'pending' }, brief, 12345, state)[0]),
  decisionCard({ ...base, id: 'recovery', kind: 'recovery', question: 'Have all previous processes stopped?', detail: recoveryDetails({ ...state, executionWindow: { id: 'old' } }, state.snapshot.baseCommit), options: [{ label: 'Confirm previous processes stopped' }, { label: 'Leave unresolved' }] })[0],
]
const browser = await chromium.launch({ headless: true, ...(channel ? { channel } : {}) })
try {
  const page = await browser.newPage()
  const render = async card => {
    await page.setContent('<style>:root{--dsh-chat-content-width:820px;--dsh-composer-side-clearance:0px}body{margin:0;font-family:Arial,sans-serif}' + css + '</style><div class="frame"><section class="card"><header class="header"><div class="headingBlock"><h2 class="title"></h2></div><div class="headerActions"><button>Close</button></div></header><div class="body"><div class="options"></div></div><footer class="footer"><div class="footerActions"><button id="submit">Submit</button></div></footer></section></div>')
    await page.evaluate(card => {
      document.querySelector('h2').textContent = card.question
      const options = document.querySelector('.options')
      for (const option of card.options) {
        const button = document.createElement('button'); button.className = 'option'; button.type = 'button'; button.setAttribute('aria-label', option.label)
        button.innerHTML = '<span class="optionCopy"><span class="optionLine"><span class="optionLabel"></span><span class="description"></span></span></span>'
        button.querySelector('.optionLabel').textContent = option.label
        button.querySelector('.description').textContent = option.description ?? ''
        button.addEventListener('click', () => { button.setAttribute('data-selected', 'true') })
        options.append(button)
      }
      document.querySelector('#submit').addEventListener('click', event => { event.target.setAttribute('data-submitted', 'true') })
    }, card)
  }
  const geometry = () => page.evaluate(() => {
    const card = document.querySelector('.card').getBoundingClientRect(), body = document.querySelector('.body'), footer = document.querySelector('#submit').getBoundingClientRect()
    return { bodyHeight: body.clientHeight, scrollHeight: body.scrollHeight, scrollable: getComputedStyle(body).overflowY === 'auto', submitReachable: footer.bottom <= card.bottom && footer.top >= card.top }
  })
  await page.setViewportSize({ width: 900, height: 800 })
  const approval = cards[0]
  await render({ ...approval, question: approval.question + '\n\n' + approval.options[0].description, options: approval.options.map(({ description, ...option }) => option) })
  assert.equal((await geometry()).submitReachable, false, 'The predecessor whole-brief title must fail this regression control')
  let count = 0
  for (const viewport of [{ width: 900, height: 800 }, { width: 480, height: 650 }, { width: 900, height: 400 }]) {
    await page.setViewportSize(viewport)
    for (const card of cards) {
      await render(card)
      const observed = await geometry()
      assert(observed.submitReachable && observed.bodyHeight > 0 && observed.scrollable && observed.scrollHeight > observed.bodyHeight, JSON.stringify({ id: card.id, viewport, observed }))
      assert.equal(await page.locator('.description').first().textContent(), card.options[0].description)
      await page.locator('.body').evaluate(element => { element.scrollTop = element.scrollHeight })
      await page.getByRole('button', { name: card.options[1].label, exact: true }).click()
      assert.equal(await page.getByRole('button', { name: card.options[1].label, exact: true }).getAttribute('data-selected'), 'true')
      await page.getByRole('button', { name: 'Submit', exact: true }).click()
      assert.equal(await page.locator('#submit').getAttribute('data-submitted'), 'true')
      count++
    }
  }
  console.log('Scrollable card layout: ' + count + ' viewport/card combinations passed; predecessor-title negative control failed as expected. Browser channel: ' + (channel ?? 'chromium'))
} finally { await browser.close() }
