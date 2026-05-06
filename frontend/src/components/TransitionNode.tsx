import { Handle, Position, type NodeProps } from '@xyflow/react'

export interface TransitionNodeData {
  label: string
  isEnabled: boolean
  isAuto: boolean
  isFiring: boolean
}

// Vertical bar — classic Petri net convention for transitions
const W = 12
const H = 54

export function TransitionNode({ data }: NodeProps) {
  const { label, isEnabled, isAuto, isFiring } = data as unknown as TransitionNodeData

  // auto = cyan (bridge fires), manual = amber (Claude fires)
  const color    = isAuto ? '#22d3ee' : '#fbbf24'
  const dimColor = '#1a3354'

  return (
    <div
      style={{
        width: W,
        height: H,
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {/* All 8 handles */}
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

      {/* Firing flash — bright burst that fades out */}
      {isFiring && (
        <div style={{
          position: 'absolute',
          inset: -10,
          borderRadius: 6,
          background: `radial-gradient(circle, ${color}ff 0%, ${color}88 40%, transparent 70%)`,
          animation: 'transitionFire 1000ms ease-out forwards',
          pointerEvents: 'none',
          zIndex: 10,
        }} />
      )}

      {/* Enabled halo */}
      {isEnabled && !isFiring && (
        <div style={{
          position: 'absolute',
          inset: -6,
          borderRadius: 4,
          background: `${color}18`,
          animation: 'transitionGlow 1.2s ease-in-out infinite',
          pointerEvents: 'none',
        }} />
      )}

      {/* Bar */}
      <div style={{
        width: W,
        height: H,
        borderRadius: 2,
        background: isEnabled
          ? `linear-gradient(180deg, ${color} 0%, ${color}99 100%)`
          : `linear-gradient(180deg, ${dimColor} 0%, #0f1d30 100%)`,
        border: `1px solid ${isEnabled ? `${color}cc` : '#0f2040'}`,
        boxShadow: isFiring
          ? `0 0 24px ${color}, 0 0 48px ${color}88`
          : isEnabled
            ? `0 0 10px ${color}88, 0 0 20px ${color}44`
            : 'none',
        transition: 'background 0.3s, box-shadow 0.3s',
        position: 'relative',
        zIndex: 1,
      }}>
        {/* Label — rotated, positioned above the bar */}
        <div style={{
          position: 'absolute',
          top: -26,
          left: '50%',
          transform: 'translateX(-50%)',
          fontSize: 7,
          color: isEnabled ? color : '#1a3354',
          fontFamily: 'JetBrains Mono, monospace',
          fontWeight: isEnabled ? 700 : 400,
          whiteSpace: 'nowrap',
          letterSpacing: '0.3px',
          textShadow: isEnabled ? `0 0 6px ${color}88` : 'none',
          transition: 'color 0.3s',
          pointerEvents: 'none',
          userSelect: 'none',
        }}>
          {label}
        </div>
      </div>
    </div>
  )
}
