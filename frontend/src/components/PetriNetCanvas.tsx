import { useMemo, useCallback } from 'react'
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  MarkerType,
  type Node,
  type Edge,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { PlaceNode } from './PlaceNode'
import { TransitionNode } from './TransitionNode'
import type { NetDefinition, OrchestratorState } from '../types'

const nodeTypes = { place: PlaceNode, transition: TransitionNode }

const PLACE_POS: Record<string, { x: number; y: number }> = {
  BACKLOG:            { x: 100,  y: 150 },
  READY_FOR_ANALYSIS: { x: 370,  y: 150 },
  ANALYZED:           { x: 640,  y: 150 },
  READY_FOR_PATCH:    { x: 910,  y: 150 },
  PATCH_CREATED:      { x: 1180, y: 150 },
  TESTING:            { x: 1450, y: 150 },
  DONE:               { x: 1720, y: 150 },
  FAILED:             { x: 1450, y: 420 },
  HUMAN_REVIEW:       { x: 1720, y: 420 },
}

const TRANS_POS: Record<string, { x: number; y: number }> = {
  claim_analysis:    { x: 235,  y: 150 },
  analysis_finished: { x: 505,  y: 150 },
  claim_patch:       { x: 775,  y: 150 },
  patch_created:     { x: 1045, y: 150 },
  start_testing:     { x: 1315, y: 150 },
  tests_passed:      { x: 1585, y: 150 },
  tests_failed:      { x: 1450, y: 285 },
  retry:             { x: 1115, y: 420 },
  escalate:          { x: 1585, y: 420 },
}

export const PLACE_COLOR: Record<string, string> = {
  BACKLOG:            '#64748b',
  READY_FOR_ANALYSIS: '#0ea5e9',
  ANALYZED:           '#8b5cf6',
  READY_FOR_PATCH:    '#f59e0b',
  PATCH_CREATED:      '#f97316',
  TESTING:            '#06b6d4',
  DONE:               '#22c55e',
  FAILED:             '#ef4444',
  HUMAN_REVIEW:       '#ec4899',
}

interface Props {
  net: NetDefinition
  state: OrchestratorState
  selectedTaskId?: string | null
  onTokenClick?: (taskId: string) => void
  firingTransitions?: Set<string>
}

export function PetriNetCanvas({
  net,
  state,
  selectedTaskId,
  onTokenClick,
  firingTransitions,
}: Props) {
  const { marking, enabled_transitions } = state

  // Stable callback reference for node data
  const handleTokenClick = useCallback(
    (taskId: string) => onTokenClick?.(taskId),
    [onTokenClick],
  )

  const nodes = useMemo<Node[]>(() => {
    const places: Node[] = net.places.map((place) => ({
      id: place,
      type: 'place',
      position: PLACE_POS[place] ?? { x: 0, y: 0 },
      data: {
        label: place,
        tokens: marking[place] ?? [],
        color: PLACE_COLOR[place] ?? '#64748b',
        hasTokens: (marking[place] ?? []).length > 0,
        selectedTaskId,
        onTokenClick: handleTokenClick,
      },
    }))

    const transitions: Node[] = net.transitions.map((tr) => ({
      id: tr.id,
      type: 'transition',
      position: TRANS_POS[tr.id] ?? { x: 0, y: 0 },
      data: {
        label: tr.id,
        isEnabled: enabled_transitions.includes(tr.id),
        isAuto: tr.auto,
        isFiring: firingTransitions?.has(tr.id) ?? false,
      },
    }))

    return [...places, ...transitions]
  }, [net, marking, enabled_transitions, selectedTaskId, handleTokenClick, firingTransitions])

  const edges = useMemo<Edge[]>(() => {
    const result: Edge[] = []

    net.transitions.forEach((tr) => {
      const isEnabled = enabled_transitions.includes(tr.id)
      const isFiring  = firingTransitions?.has(tr.id) ?? false
      const toColor   = PLACE_COLOR[tr.to] ?? '#64748b'

      const routing: Record<string, { sH: string; tH: string; type?: string }> = {
        claim_analysis:    { sH: 'source-right', tH: 'target-left' },
        analysis_finished: { sH: 'source-right', tH: 'target-left' },
        claim_patch:       { sH: 'source-right', tH: 'target-left' },
        patch_created:     { sH: 'source-right', tH: 'target-left' },
        start_testing:     { sH: 'source-right', tH: 'target-left' },
        tests_passed:      { sH: 'source-right', tH: 'target-left' },
        tests_failed:      { sH: 'source-bottom', tH: 'target-top' },
        escalate:          { sH: 'source-right',  tH: 'target-left' },
        retry:             { sH: 'source-left',   tH: 'target-right', type: 'smoothstep' },
      }

      tr.from.forEach((fromPlace) => {
        const fromColor = PLACE_COLOR[fromPlace] ?? '#64748b'
        const activeColor = isFiring ? fromColor : isEnabled ? fromColor : '#162035'
        const r = routing[tr.id] ?? { sH: 'source-right', tH: 'target-left' }
        const fromHandle =
          tr.id === 'escalate' && fromPlace === 'TESTING' ? 'source-bottom'
          : tr.id === 'escalate' && fromPlace === 'FAILED'  ? 'source-right'
          : r.sH

        result.push({
          id: `${fromPlace}=>${tr.id}`,
          source: fromPlace,
          target: tr.id,
          sourceHandle: fromHandle,
          targetHandle: r.tH,
          animated: isEnabled || isFiring,
          type: r.type ?? 'smoothstep',
          style: {
            stroke: activeColor,
            strokeWidth: isFiring ? 2.5 : isEnabled ? 1.5 : 0.8,
            filter: isFiring
              ? `drop-shadow(0 0 6px ${fromColor})`
              : isEnabled ? `drop-shadow(0 0 3px ${fromColor}99)` : 'none',
          },
          markerEnd: { type: MarkerType.Arrow, color: activeColor, width: 14, height: 14 },
        })
      })

      // Output arc
      const outColor = isFiring ? toColor : isEnabled ? toColor : '#162035'
      const r = routing[tr.id] ?? { sH: 'source-right', tH: 'target-left' }
      const outSH = tr.id === 'retry' ? 'source-top' : r.sH
      const outTH = tr.id === 'retry' ? 'target-bottom' : r.tH

      result.push({
        id: `${tr.id}=>${tr.to}`,
        source: tr.id,
        target: tr.to,
        sourceHandle: outSH,
        targetHandle: outTH,
        animated: isEnabled || isFiring,
        type: r.type ?? 'smoothstep',
        style: {
          stroke: outColor,
          strokeWidth: isFiring ? 2.5 : isEnabled ? 1.5 : 0.8,
          filter: isFiring
            ? `drop-shadow(0 0 6px ${toColor})`
            : isEnabled ? `drop-shadow(0 0 3px ${toColor}99)` : 'none',
        },
        markerEnd: { type: MarkerType.Arrow, color: outColor, width: 14, height: 14 },
      })
    })

    return result
  }, [net, marking, enabled_transitions, firingTransitions])

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      nodeOrigin={[0.5, 0.5]}
      fitView
      fitViewOptions={{ padding: 0.14 }}
      proOptions={{ hideAttribution: true }}
      colorMode="dark"
      minZoom={0.3}
      maxZoom={2}
      defaultEdgeOptions={{ type: 'smoothstep' }}
    >
      <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="#1a2d45" />
      <Controls style={{ background: '#0a1628', border: '1px solid #1e3a5f', borderRadius: 8, gap: 2 }} />
      <MiniMap
        style={{ background: '#060e1e', border: '1px solid #1e3a5f', borderRadius: 8 }}
        nodeColor={(n) => {
          if (n.type === 'transition') {
            const d = n.data as { isEnabled: boolean; isAuto: boolean; isFiring: boolean }
            if (d.isFiring) return '#ffffff'
            if (!d.isEnabled) return '#1a3354'
            return d.isAuto ? '#22d3ee' : '#fbbf24'
          }
          const d = n.data as { hasTokens: boolean; color: string }
          return d.hasTokens ? d.color : '#0f1d30'
        }}
        maskColor="rgba(1,2,18,0.75)"
      />
    </ReactFlow>
  )
}
