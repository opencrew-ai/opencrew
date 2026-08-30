import { useEffect, useState } from 'react'
import { wsClient } from './ws'

/**
 * Live "now doing" labels per agent, fed by agent_activity WS events.
 * null/absent = idle. Member-visible by design (labels are coarse).
 */
export function useAgentActivity(): Map<string, string> {
  const [labels, setLabels] = useState<Map<string, string>>(new Map())

  useEffect(() => {
    return wsClient.subscribe((event) => {
      if (event.type !== 'agent_activity') return
      setLabels((prev) => {
        const next = new Map(prev)
        if (event.label) {
          next.set(event.agentId, event.label)
        } else {
          next.delete(event.agentId)
        }
        return next
      })
    })
  }, [])

  return labels
}
