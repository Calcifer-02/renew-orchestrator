import { Handle, Position, type NodeProps } from '@xyflow/react'

export interface TransitionNodeData {
  label: string
  isEnabled: boolean
  isAuto: boolean
}

// Vertical bar — classic Petri net convention for transitions
const W = 12
const H = 54

export function TransitionNode({ data }: NodeProps) {
  const { label, isEnabled, isAuto } = data as unknown as TransitionNodeData

  // auto = cyan (bridge fires), manual = amber (Claude fires)
  const color = isAuto ? '#22d3ee' : '#fbbf24'
  const dimColor = '#1a3354'

  return (
    <div style={{ width: W, height: H, position: 'relative' }}>
      {(['target', 'source'] as const).map((type) =>
        ([Position.Left, Position.Right, Position.Top, Position.Bottom] as const).map((pos) => (
          <Handle
            key={`${type}-${pos}`}
            id={`${type}-${pos}`}
            type={type}
            position={pos}
            style={{ opacity: 0, pointerEvents: 'none', width: 1, height: 1 }}
          />
        )),
      )}

      {/* Soft glow halo behind when enabled */}
      {isEnabled && (
        <div
          style={{
            position: 'absolute',
            inset: -10,
            background: `radial-gradient(ellipse 60% 80% at 50% 50%, ${color}44 0%, transparent 70%)`,
            animation: 'transitionGlow 1.2s ease-in-out infinite',
            pointerEvents: 'none',
          }}
        />
      )}

      {/* Main bar */}
      <div
        title={label.replace(/_/g, ' ')}
        style={{
          width: '100%',
          height: '100%',
          borderRadius: 2,
          background: isEnabled
            ? `linear-gradient(180deg, ${color}ff 0%, ${color}bb 100%)`
            : `linear-gradient(180deg, ${dimColor} 0%, #0d1e38 100%)`,
          border: `1px solid ${isEnabled ? color : '#1e3a5f'}`,
          boxShadow: isEnabled
            ? `0 0 10px ${color}cc, 0 0 22px ${color}88, 0 0 40px ${color}44`
            : 'none',
          transition: 'all 0.35s cubic-bezier(0.4, 0, 0.2, 1)',
          animation: isEnabled ? 'transitionGlow 1.2s ease-in-out infinite' : 'none',
          cursor: 'default',
        }}
      />

      {/* Label tooltip (rendered as ::after via title attr — native browser tooltip) */}
    </div>
  )
}
