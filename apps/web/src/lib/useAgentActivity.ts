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

/** Channels with an agent actively working in them right now. */
export function useLiveChannels(): Set<string> {
  const [byAgent, setByAgent] = useState<Map<string, string>>(new Map())

  useEffect(() => {
    return wsClient.subscribe((event) => {
      if (event.type !== 'agent_activity') return
      setByAgent((prev) => {
        const next = new Map(prev)
        if (event.label && event.channelId) {
          next.set(event.agentId, event.channelId)
        } else {
          next.delete(event.agentId)
        }
        return next
      })
    })
  }, [])

  return new Set(byAgent.values())
}

export interface ConversationWorker {
  agentId: string
  label: string
}

/**
 * Who is working THIS conversation right now, with their live activity label.
 * Scoped by the threadRootId the server stamps on agent_activity events;
 * cleared when the run reaches a terminal state.
 */
export function useConversationActivity(rootId: string): ConversationWorker[] {
  const [workers, setWorkers] = useState<Map<string, string>>(new Map())

  useEffect(() => {
    setWorkers(new Map())
    return wsClient.subscribe((event) => {
      if (event.type !== 'agent_activity') return
      const matches = event.threadRootId === rootId
      setWorkers((prev) => {
        // A terminal-state clear applies wherever the agent was listed, even
        // if the event's conversation stamp is missing (older servers).
        if (!event.label) {
          if (!prev.has(event.agentId)) return prev
          const next = new Map(prev)
          next.delete(event.agentId)
          return next
        }
        if (!matches) return prev
        const next = new Map(prev)
        next.set(event.agentId, event.label)
        return next
      })
    })
  }, [rootId])

  return [...workers.entries()].map(([agentId, label]) => ({ agentId, label }))
}
