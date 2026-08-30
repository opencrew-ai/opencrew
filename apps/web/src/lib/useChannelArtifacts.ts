import { createContext, useContext, useEffect, useState } from 'react'
import type { Artifact } from '@opencrew/shared'
import { api } from './api'
import { wsClient } from './ws'

/**
 * Artifacts grouped by the run that produced them — provided by ChannelView
 * so any MessageItem (including thread replies) can render the doc card
 * inline under the exact message that announced it.
 */
export const ArtifactsByRunContext = createContext<Map<string, Artifact[]>>(new Map())

export function useArtifactsForRun(runId: string | undefined): Artifact[] {
  const byRun = useContext(ArtifactsByRunContext)
  return runId ? (byRun.get(runId) ?? []) : []
}

/** Same artifacts keyed by id — for messages that anchor a card explicitly. */
export const ArtifactsByIdContext = createContext<Map<string, Artifact>>(new Map())

export function useArtifactById(artifactId: string | undefined): Artifact | undefined {
  const byId = useContext(ArtifactsByIdContext)
  return artifactId ? byId.get(artifactId) : undefined
}

/**
 * Artifacts for every conversation in a channel: REST snapshot merged with
 * live artifact_state events. Discarded artifacts are dropped. Keyed by
 * conversationRootId, newest first.
 */
export function useChannelArtifacts(channelId: string): Map<string, Artifact[]> {
  const [byRoot, setByRoot] = useState<Map<string, Artifact[]>>(new Map())

  useEffect(() => {
    setByRoot(new Map())
    let cancelled = false
    api
      .get<Artifact[]>(`/api/channels/${channelId}/artifacts`)
      .then((rows) => {
        if (cancelled) return
        const map = new Map<string, Artifact[]>()
        for (const artifact of rows) {
          if (artifact.status === 'discarded') continue
          map.set(artifact.conversationRootId, [
            ...(map.get(artifact.conversationRootId) ?? []),
            artifact
          ])
        }
        setByRoot(map)
      })
      .catch(() => {
        // Transient — live artifact_state events still populate the map.
      })
    return () => {
      cancelled = true
    }
  }, [channelId])

  useEffect(() => {
    return wsClient.subscribe((event) => {
      if (event.type !== 'artifact_state') return
      const artifact = event.artifact
      if (artifact.channelId !== channelId) return
      setByRoot((prev) => {
        const next = new Map(prev)
        const rootId = artifact.conversationRootId
        const others = (next.get(rootId) ?? []).filter((a) => a.id !== artifact.id)
        const list = artifact.status === 'discarded' ? others : [artifact, ...others]
        if (list.length === 0) {
          next.delete(rootId)
        } else {
          next.set(rootId, list)
        }
        return next
      })
    })
  }, [channelId])

  return byRoot
}
