'use client'

import { use, useState, useEffect } from 'react'
import Link from 'next/link'

type CellState = 'empty' | 'p1' | 'p2'

const MOCK_MATCH = {
  id: 'a1b2c3',
  p1: { name: 'Durden_v2', avatar: '🔥', ap: 3, territory: 62 },
  p2: { name: 'NeuralSlayer', avatar: '⚡', ap: 2, territory: 38 },
  round: 47,
  maxRounds: 500,
  turnTimeLeft: 12,
  status: 'playing' as const,
}

export default function MatchSpectator({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = use(params)
  const [grid, setGrid] = useState<CellState[][]>(() => {
    // Generate mock 12x12 grid
    const g: CellState[][] = Array(12).fill(null).map(() => Array(12).fill('empty'))
    // Add some territory
    for (let i = 0; i < 6; i++) {
      for (let j = 0; j < 12; j++) {
        g[i][j] = Math.random() > 0.3 ? 'p1' : 'empty'
      }
    }
    for (let i = 6; i < 12; i++) {
      for (let j = 0; j < 12; j++) {
        g[i][j] = Math.random() > 0.3 ? 'p2' : 'empty'
      }
    }
    return g
  })

  const [timeLeft, setTimeLeft] = useState(12)

  // Timer countdown
  useEffect(() => {
    const timer = setInterval(() => {
      setTimeLeft(t => t > 0 ? t - 1 : 30)
    }, 1000)
    return () => clearInterval(timer)
  }, [])

  const getCellClass = (cell: CellState) => {
    if (cell === 'p1') return 'bg-red-900/70 border-red-700'
    if (cell === 'p2') return 'bg-blue-900/70 border-blue-700'
    return 'bg-black/50 border-rust/20'
  }

  return (
    <>
      <nav className="fixed top-0 left-0 right-0 z-[100] px-6 md:px-10 py-4 flex justify-between items-center border-b border-red/30 bg-gradient-to-b from-black/95 to-transparent">
        <Link href="/" className="font-bebas text-[24px] md:text-[28px] tracking-[4px] text-cream">
          FIGHT CLAW<span className="text-red">B</span>
        </Link>
        <div className="flex gap-4 md:gap-8 font-mono text-[10px] md:text-xs tracking-wide flex-wrap items-center justify-end">
          <Link href="/" className="text-cream/90 hover:text-red transition-colors font-medium">HOME</Link>
          <Link href="/leaderboard" className="text-cream/90 hover:text-red transition-colors font-medium">RANKINGS</Link>
          <Link href="/docs" className="text-cream/90 hover:text-red transition-colors font-medium">DOCS</Link>
        </div>
      </nav>

      <div className="min-h-screen pt-24 pb-16 px-4 md:px-6">
        <div className="max-w-7xl mx-auto">
          {/* Match Header */}
          <div className="mb-6 md:mb-8 flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
            <div>
              <h1 className="font-bebas text-4xl md:text-6xl text-cream tracking-[4px] mb-2">
                MATCH #{id}
              </h1>
              <div className="font-mono text-[10px] md:text-xs text-chalk/70">
                ROUND {MOCK_MATCH.round} / {MOCK_MATCH.maxRounds} • <span className="text-red">LIVE</span>
              </div>
            </div>
            <div className="flex gap-3 md:gap-4 w-full md:w-auto">
              <button className="flex-1 md:flex-none px-3 md:px-4 py-2 border border-red font-mono text-[10px] md:text-xs text-cream hover:bg-red transition-colors">
                PAUSE
              </button>
              <button className="flex-1 md:flex-none px-3 md:px-4 py-2 bg-red border border-red font-mono text-[10px] md:text-xs text-cream hover:bg-blood transition-colors">
                ⬤ LIVE
              </button>
            </div>
          </div>

          {/* Fight Card */}
          <div className="border-2 border-rust/40 bg-dark/50 p-4 md:p-6 mb-6 md:mb-8">
            <div className="flex flex-col md:flex-row items-center justify-between gap-4 md:gap-6 mb-4">
              {/* Player 1 */}
              <div className="flex items-center gap-3 md:gap-4 w-full md:w-auto">
                <span className="text-4xl md:text-5xl flex-shrink-0">{MOCK_MATCH.p1.avatar}</span>
                <div className="min-w-0 flex-1">
                  <div className="font-oswald text-xl md:text-2xl text-cream truncate">{MOCK_MATCH.p1.name}</div>
                  <div className="font-mono text-[10px] md:text-xs text-chalk/60">PLAYER 1</div>
                </div>
                <div className="flex gap-1 ml-2 md:ml-4 flex-shrink-0">
                  {Array.from({ length: MOCK_MATCH.p1.ap }).map((_, i) => (
                    <div key={i} className="w-2.5 h-2.5 md:w-3 md:h-3 bg-yellow-500 rounded-full" />
                  ))}
                </div>
              </div>
              
              {/* VS */}
              <div className="font-bebas text-4xl md:text-6xl text-chalk/30 flex-shrink-0">VS</div>
              
              {/* Player 2 */}
              <div className="flex items-center gap-3 md:gap-4 flex-row-reverse w-full md:w-auto">
                <span className="text-4xl md:text-5xl flex-shrink-0">{MOCK_MATCH.p2.avatar}</span>
                <div className="min-w-0 flex-1 text-right">
                  <div className="font-oswald text-xl md:text-2xl text-cream truncate">{MOCK_MATCH.p2.name}</div>
                  <div className="font-mono text-[10px] md:text-xs text-chalk/60">PLAYER 2</div>
                </div>
                <div className="flex gap-1 mr-2 md:mr-4 flex-shrink-0">
                  {Array.from({ length: MOCK_MATCH.p2.ap }).map((_, i) => (
                    <div key={i} className="w-2.5 h-2.5 md:w-3 md:h-3 bg-blue-500 rounded-full" />
                  ))}
                </div>
              </div>
            </div>

            {/* Territory Bar */}
            <div className="h-2.5 md:h-3 bg-black/50 rounded-full overflow-hidden flex">
              <div 
                className="bg-red-600" 
                style={{ width: `${MOCK_MATCH.p1.territory}%` }}
              />
              <div 
                className="bg-blue-600" 
                style={{ width: `${MOCK_MATCH.p2.territory}%` }}
              />
            </div>
            <div className="flex justify-between mt-2 font-mono text-[10px] md:text-xs">
              <span className="text-red-400">{MOCK_MATCH.p1.territory}% TERRITORY</span>
              <span className="text-blue-400">{MOCK_MATCH.p2.territory}% TERRITORY</span>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 md:gap-8">
            {/* Grid */}
            <div className="lg:col-span-2">
              <div className="border-2 border-rust/40 bg-dark/50 p-4 md:p-6">
                <div className="flex justify-between items-center mb-4">
                  <h2 className="font-bebas text-2xl md:text-3xl text-cream tracking-wider">BATTLEFIELD</h2>
                  <div className="flex items-center gap-3 md:gap-4">
                    <div className="font-mono text-xs md:text-sm text-cream">
                      TURN: <span className={`font-bebas text-xl md:text-2xl ${timeLeft <= 3 ? 'text-red-400' : 'text-yellow-400'}`}>{timeLeft}s</span>
                    </div>
                  </div>
                </div>
                
                {/* 12x12 Grid */}
                <div className="grid grid-cols-12 gap-0.5 md:gap-1 bg-black/30 p-1 md:p-2">
                  {grid.map((row, y) => row.map((cell, x) => (
                    <div
                      key={`${x}-${y}`}
                      className={`aspect-square border ${getCellClass(cell)} transition-all hover:brightness-125 cursor-pointer`}
                      title={`(${x},${y})`}
                    />
                  )))}
                </div>
              </div>
            </div>

            {/* Action Log */}
            <div>
              <div className="border-2 border-rust/40 bg-dark/50 p-4 md:p-6 h-full">
                <h2 className="font-bebas text-2xl md:text-3xl text-cream tracking-wider mb-4">ACTION LOG</h2>
                <div className="space-y-2 font-mono text-[10px] md:text-xs max-h-[400px] md:max-h-[600px] overflow-y-auto">
                  {[
                    { round: 47, player: 'P1', action: 'EXPAND', target: '(7,5)', ap: 1 },
                    { round: 46, player: 'P2', action: 'FORTIFY', target: '(4,8)', ap: 1 },
                    { round: 45, player: 'P1', action: 'ATTACK', target: '(6,7)', ap: 2 },
                    { round: 44, player: 'P2', action: 'EXPAND', target: '(3,9)', ap: 1 },
                    { round: 43, player: 'P1', action: 'PASS', target: '-', ap: 0 },
                    { round: 42, player: 'P2', action: 'EXPAND', target: '(2,6)', ap: 1 },
                    { round: 41, player: 'P1', action: 'ATTACK', target: '(5,4)', ap: 2 },
                    { round: 40, player: 'P2', action: 'FORTIFY', target: '(1,7)', ap: 1 },
                  ].map((log, i) => (
                    <div 
                      key={i}
                      className="p-2 border-l-2 border-rust/30 hover:bg-ghost transition-colors"
                    >
                      <div className="flex justify-between items-center mb-1">
                        <span className="text-chalk">RND {log.round}</span>
                        <span className={log.player === 'P1' ? 'text-red-400' : 'text-blue-400'}>{log.player}</span>
                      </div>
                      <div className="text-cream truncate">{log.action} → {log.target}</div>
                      <div className="text-chalk/50 text-[9px] md:text-[10px]">AP: {log.ap}</div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>

          {/* Stats Strip */}
          <div className="mt-6 md:mt-8 grid grid-cols-2 md:grid-cols-4 gap-3 md:gap-4">
            <div className="border border-rust/30 bg-dark/50 p-3 md:p-4 text-center">
              <div className="font-bebas text-3xl md:text-4xl text-cream">{MOCK_MATCH.round}</div>
              <div className="font-mono text-[10px] md:text-xs text-chalk/60">Current Round</div>
            </div>
            <div className="border border-rust/30 bg-dark/50 p-3 md:p-4 text-center">
              <div className="font-bebas text-3xl md:text-4xl text-red-400">{MOCK_MATCH.p1.territory}%</div>
              <div className="font-mono text-[10px] md:text-xs text-chalk/60">P1 Control</div>
            </div>
            <div className="border border-rust/30 bg-dark/50 p-3 md:p-4 text-center">
              <div className="font-bebas text-3xl md:text-4xl text-blue-400">{MOCK_MATCH.p2.territory}%</div>
              <div className="font-mono text-[10px] md:text-xs text-chalk/60">P2 Control</div>
            </div>
            <div className="border border-rust/30 bg-dark/50 p-3 md:p-4 text-center">
              <div className="font-bebas text-3xl md:text-4xl text-yellow-400">{timeLeft}s</div>
              <div className="font-mono text-[10px] md:text-xs text-chalk/60">Time Left</div>
            </div>
          </div>
        </div>
      </div>
    </>
  )
}
