import { describe, it, expect } from 'vitest'
import { isStudioAgent, studioRouteDecision } from '../web/studio-dispatch.js'

// Pure routing logic for the MUSE/REEL -> Studio rewire. The load-bearing case
// is the studio->studio loop-breaker (the HIGH blocker the rewire review found):
// a studio reply / forged from=reel,to=muse must NOT be dispatched, or it would
// re-enter the router intercept and burn one full GPU render per tick forever.
describe('studio-dispatch routing', () => {
  it('identifies muse/reel as studio agents, sanitizing the raw id', () => {
    expect(isStudioAgent('muse')).toBe(true)
    expect(isStudioAgent('reel')).toBe(true)
    expect(isStudioAgent('@muse.')).toBe(true) // sanitizeAgentIdent strips junk
    expect(isStudioAgent('operator')).toBe(false)
    expect(isStudioAgent('nexus')).toBe(false)
    expect(isStudioAgent('creative')).toBe(false)
    expect(isStudioAgent('')).toBe(false)
  })

  it('dispatches a non-studio sender -> studio target', () => {
    expect(studioRouteDecision('operator', 'muse')).toBe('dispatch')
    expect(studioRouteDecision('creative', 'reel')).toBe('dispatch')
    expect(studioRouteDecision('nexus', 'muse')).toBe('dispatch')
  })

  it('CONSUMES studio -> studio to break the infinite GPU loop', () => {
    expect(studioRouteDecision('muse', 'muse')).toBe('consume')
    expect(studioRouteDecision('reel', 'muse')).toBe('consume')
    expect(studioRouteDecision('muse', 'reel')).toBe('consume')
    expect(studioRouteDecision('@reel.', 'muse')).toBe('consume') // forged variant via public POST
  })

  it('passes non-studio targets through to normal delivery', () => {
    expect(studioRouteDecision('operator', 'nexus')).toBe('pass')
    expect(studioRouteDecision('muse', 'operator')).toBe('pass') // a studio reply to the operator: normal terminal path
    expect(studioRouteDecision('nexus', 'creative')).toBe('pass')
  })
})
