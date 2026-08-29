import { useEffect, useState, useCallback } from 'react'
import { api } from './api'

export interface AgentLoad {
  agentId: string
  name: string
  emoji: string
  status: 'idle' | 'busy' | 'rate_limited' | 'paused'
  activeRuns: number
  runsLastHour: number
  maxRunsPerHour: number
}

const POLL_INTERVAL_MS = 30_000 // refresh every 30s

/**
 * Polls /api/agents/load on an interval. Returns a Map<agentId, AgentLoad>
 * for O(1) lookups from the sidebar / crew bar.
 */
export function useAgentLoad(): Map<string, AgentLoad> {
  const [loadMap, setLoadMap] = useState<Map<string, AgentLoad>>(new Map())

  const fetch = useCallback(() => {
    api
      .get<AgentLoad[]>('/api/agents/load')
      .then((list) => {
        setLoadMap(new Map(list.map((l) => [l.agentId, l])))
      })
      .catch(() => {
        /* ignore — stale data is fine */
      })
  }, [])

  useEffect(() => {
    fetch()
    const id = setInterval(fetch, POLL_INTERVAL_MS)
    return () => clearInterval(id)
  }, [fetch])

  return loadMap
}
