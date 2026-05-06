import { Handle, Position, type NodeProps } from '@xyflow/react'

export interface PlaceNodeData {
  label: string
  tokens: string[]
  color: string
  hasTokens: boolean
}

const PLACE_LABEL: Record<string, string> = {
  BACKLOG:             'BACKLOG',
  READY_FOR_ANALYSIS:  'READY\nANALYSIS',
  ANALYZED:            'ANALYZED',
  READY_FOR_PATCH:     'READY\nPATCH',
  PATCH_CREATED:       'PATCH\nCREATED',
  TESTING:             'TESTING',
  DONE:                'DONE',
  FAILED:              'FAILED',
  HUMAN_REVIEW:        'HUMAN\nREVIEW',
}

const SIZE = 90

export function PlaceNode({ data }: NodeProps) {
  const { label, tokens, color, hasTokens } = data as unknown as PlaceNodeData

  return (
    <div style={{ width: SIZE, height: SIZE, position: 'relative' }}>
      {/* All 8 handles — invisible, just for edge routing */}
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

      {/* Outer ambient glow ring */}
      {hasTokens && (
        <div
          style={{
            position: 'absolute',
            inset: -14,
            borderRadius: '50%',
            background: `radial-gradient(circle, ${color}50 0%, transparent 65%)`,
            animation: 'outerGlow 2s ease-in-out infinite',
            pointerEvents: 'none',
          }}
        />
      )}

      {/* Double-ring: outer decorative ring */}
      <div
        style={{
          position: 'absolute',
          inset: 2,
          borderRadius: '50%',
          border: `1px solid ${hasTokens ? `${color}55` : '#0f2040'}`,
          pointerEvents: 'none',
        }}
      />

      {/* Main circle */}
      <div
        style={{
          position: 'absolute',
          inset: 7,
          borderRadius: '50%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 3,
          background: hasTokens
            ? `radial-gradient(circle at 38% 32%, ${color}28 0%, ${color}08 60%, transparent 100%)`
            : 'radial-gradient(circle at 38% 32%, #14243e 0%, #080f1e 100%)',
          border: `1.5px solid ${hasTokens ? color : '#1a3354'}`,
          boxShadow: hasTokens
            ? `0 0 18px ${color}88, 0 0 36px ${color}44, 0 0 60px ${color}22, inset 0 0 14px ${color}1a`
            : 'inset 0 0 10px rgba(0,0,0,0.6)',
          transition: 'all 0.5s cubic-bezier(0.4, 0, 0.2, 1)',
          overflow: 'hidden',
        }}
      >
        {/* Token dots */}
        {tokens.length > 0 && (
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              justifyContent: 'center',
              gap: 3,
              maxWidth: 54,
            }}
          >
            {tokens.map((tid) => (
              <div
                key={tid}
                title={tid}
                style={{
                  width: 9,
                  height: 9,
                  borderRadius: '50%',
                  background: color,
                  color,
                  animation: 'tokenPulse 1.8s ease-in-out infinite',
                  flexShrink: 0,
                }}
              />
            ))}
          </div>
        )}

        {/* Token IDs (tiny) */}
        {tokens.length > 0 && (
          <div
            style={{
              fontSize: 6.5,
              color: `${color}dd`,
              fontFamily: 'JetBrains Mono, monospace',
              textAlign: 'center',
              lineHeight: 1.3,
              letterSpacing: '0.2px',
              maxWidth: 58,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {tokens.join(' ')}
          </div>
        )}

        {/* Place label */}
        <div
          style={{
            fontSize: 7,
            color: hasTokens ? color : '#2d4f7a',
            fontFamily: 'JetBrains Mono, monospace',
            fontWeight: hasTokens ? 700 : 400,
            textAlign: 'center',
            lineHeight: 1.25,
            letterSpacing: '0.6px',
            whiteSpace: 'pre-line',
            transition: 'color 0.4s ease',
            textShadow: hasTokens ? `0 0 8px ${color}88` : 'none',
          }}
        >
          {PLACE_LABEL[label] ?? label}
        </div>
      </div>
    </div>
  )
}
