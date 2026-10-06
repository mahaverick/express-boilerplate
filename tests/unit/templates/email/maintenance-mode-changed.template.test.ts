/**
 * @file The maintenance-mode notice: what it says, HTML escaping of every
 * interpolated value, and the missing-variable guard.
 */
import { describe, expect, it } from 'vitest'
import {
  MAINTENANCE_MODE_CHANGED_TEMPLATE_KEY,
  renderMaintenanceModeChangedTemplate,
  type MaintenanceModeChangedVariables,
} from '@/templates/email/maintenance-mode-changed.template'

const VARIABLES: MaintenanceModeChangedVariables = {
  firstName: 'Ada',
  appName: 'Acme',
  mode: 'full',
  actorName: 'Grace Hopper',
  reason: 'Database upgrade',
  changedAt: '2026-10-06T10:42:00.000Z',
}

describe('renderMaintenanceModeChangedTemplate', () => {
  it('names the mode, the actor, the reason and the time', () => {
    const rendered = renderMaintenanceModeChangedTemplate(VARIABLES)

    expect(rendered.templateKey).toBe(MAINTENANCE_MODE_CHANGED_TEMPLATE_KEY)
    expect(rendered.subject).toBe('Acme maintenance mode is now full')
    expect(rendered.text).toContain(
      'Grace Hopper set Acme maintenance mode to full at 2026-10-06T10:42:00.000Z.'
    )
    expect(rendered.text).toContain('Reason: Database upgrade')
    expect(rendered.html).toContain('Reason: Database upgrade')
  })

  it('escapes every value in the HTML part and none in the text part', () => {
    const rendered = renderMaintenanceModeChangedTemplate({
      ...VARIABLES,
      actorName: '<b>Grace</b>',
      reason: 'a & b <script>',
    })

    expect(rendered.html).toContain('&lt;b&gt;Grace&lt;/b&gt;')
    expect(rendered.html).toContain('a &amp; b &lt;script&gt;')
    expect(rendered.html).not.toContain('<script>')
    expect(rendered.text).toContain('a & b <script>')
  })

  it('refuses to render without a variable', () => {
    const withoutReason: Partial<MaintenanceModeChangedVariables> = { ...VARIABLES }
    delete withoutReason.reason

    expect(() =>
      renderMaintenanceModeChangedTemplate(withoutReason as MaintenanceModeChangedVariables)
    ).toThrow('required variable "reason" is missing')
  })
})
