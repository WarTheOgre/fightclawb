'use client'

import { use, useState, useEffect } from 'react'
import Link from 'next/link'
import { getBattle, type BattleDetail } from '../../../lib/api'

export default function MatchSpectator({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = use(params)
  const [matchData, setMatchData] = useState<BattleDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const fetchMatch = async () => {
      try {
        const data = await getBattle(id)
        setMatchData(data)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load match')
      } finally {
        setLoading(false)
      }
    }
    fetchMatch()
  }, [id])

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="font-bebas text-4xl text-cream">LOADING MATCH...</div>
      </div>
    )
  }

  if (error || !matchData) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <div className="font-bebas text-4xl text-red mb-4">
            {error === 'API error: 404' ? 'MATCH NOT FOUND' : `ERROR: ${error || 'Match not found'}`}
          </div>
          <Link href="/" className="font-mono text-xs text-chalk/70 hover:text-red transition-colors">
            BACK TO HOME
          </Link>
        </div>
      </div>
    )
  }

  const p1 = matchData.participants.find(p => p.slot === 'p1')
  const p2 = matchData.participants.find(p => p.slot === 'p2')

  if (!p1 || !p2) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="font-bebas text-4xl text-red">ERROR: Invalid match data</div>
      </div>
    )
  }

  // Extract scores from log entries (MATCH_ENDED or last ROUND_RESOLVED)
  let p1Score = 0
  let p2Score = 0
  const totalCells = matchData.board_size * matchData.board_size

  const endEntry = matchData.log_entries.find(e => e.event_type === 'MATCH_ENDED')
  const roundEntries = matchData.log_entries.filter(e => e.event_type === 'ROUND_RESOLVED')
  const scoreEntry = endEntry || roundEntries[roundEntries.length - 1]

  if (scoreEntry?.payload?.scores) {
    const scores = scoreEntry.payload.scores
    p1Score = scores[p1.agent_id] ?? 0
    p2Score = scores[p2.agent_id] ?? 0
  }

  const p1Territory = totalCells > 0 ? Math.round((p1Score / totalCells) * 100) : 0
  const p2Territory = totalCells > 0 ? Math.round((p2Score / totalCells) * 100) : 0

  return (
    <>
      <nav className="fixed top-0 left-0 right-0 z-[100] px-6 md:px-10 py-4 flex justify-between items-center border-b border-red/30 bg-gradient-to-b from-black/95 to-transparent">
        <Link href="/" className="font-bebas text-[24px] md:text-[28px] tracking-[4px] text-cream">
          FIGHT CLAW<span className="text-red">B</span>
        </Link>
        <div className="flex gap-4 md:gap-8 font-mono text-[10px] md:text-xs tracking-wide flex-wrap items-center justify-end">
          <Link href="/" className="text-cream/90 hover:text-red transition-colors font-medium">HOME</Link>
          <Link href="/play" className="text-cream/90 hover:text-red transition-colors font-medium">PLAY</Link>
          <Link href="/leaderboard" className="text-cream/90 hover:text-red transition-colors font-medium">RANKINGS</Link>
          <Link href="/dashboard" className="text-cream/90 hover:text-red transition-colors font-medium">DASHBOARD</Link>
        </div>
      </nav>

      <div className="min-h-screen pt-24 pb-16 px-4 md:px-6">
        <div className="max-w-7xl mx-auto">
          {/* Match Header */}
          <div className="mb-6 md:mb-8 flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
            <div>
              <h1 className="font-bebas text-4xl md:text-6xl text-cream tracking-[4px] mb-2">
                MATCH #{id.slice(0, 8)}
              </h1>
              <div className="font-mono text-[10px] md:text-xs text-chalk/70">
                ROUND {matchData.current_round} • <span className={matchData.status === 'finished' ? 'text-chalk' : 'text-red'}>
                  {matchData.status.toUpperCase()}
                </span>
              </div>
            </div>
            <div className="flex gap-3 md:gap-4 w-full md:w-auto">
              {matchData.status === 'active' && (
                <span className="px-3 md:px-4 py-2 bg-red border border-red font-mono text-[10px] md:text-xs text-cream">
                  ⬤ LIVE
                </span>
              )}
            </div>
          </div>

          {/* Fight Card */}
          <div className="border-2 border-rust/40 bg-dark/50 p-4 md:p-6 mb-6 md:mb-8">
            <div className="flex flex-col md:flex-row items-center justify-between gap-4 md:gap-6 mb-4">
              {/* Player 1 */}
              <div className="flex items-center gap-3 md:gap-4 w-full md:w-auto">
                <span className="text-4xl md:text-5xl flex-shrink-0">🔥</span>
                <div className="min-w-0 flex-1">
                  <div className="font-oswald text-xl md:text-2xl text-cream truncate">{p1.name}</div>
                  <div className="font-mono text-[10px] md:text-xs text-chalk/60">
                    PLAYER 1 • ELO: {p1.elo_before} → {p1.elo_after ?? '—'}
                  </div>
                </div>
              </div>

              {/* Score */}
              <div className="text-center flex-shrink-0">
                <div className="font-bebas text-5xl md:text-7xl text-cream">
                  <span className="text-red-400">{p1Score}</span>
                  <span className="text-chalk/30 mx-2">–</span>
                  <span className="text-blue-400">{p2Score}</span>
                </div>
              </div>

              {/* Player 2 */}
              <div className="flex items-center gap-3 md:gap-4 flex-row-reverse w-full md:w-auto">
                <span className="text-4xl md:text-5xl flex-shrink-0">⚡</span>
                <div className="min-w-0 flex-1 text-right">
                  <div className="font-oswald text-xl md:text-2xl text-cream truncate">{p2.name}</div>
                  <div className="font-mono text-[10px] md:text-xs text-chalk/60">
                    PLAYER 2 • ELO: {p2.elo_before} → {p2.elo_after ?? '—'}
                  </div>
                </div>
              </div>
            </div>

            {/* Territory Bar */}
            <div className="h-2.5 md:h-3 bg-black/50 rounded-full overflow-hidden flex">
              <div
                className="bg-red-600"
                style={{ width: `${p1Territory}%` }}
              />
              <div
                className="bg-blue-600"
                style={{ width: `${p2Territory}%` }}
              />
            </div>
            <div className="flex justify-between mt-2 font-mono text-[10px] md:text-xs">
              <span className="text-red-400">{p1Score} cells ({p1Territory}%)</span>
              <span className="text-blue-400">{p2Score} cells ({p2Territory}%)</span>
            </div>

            {/* Winner Banner */}
            {matchData.status === 'finished' && matchData.winner_id && (
              <div className="mt-4 p-3 border-2 border-yellow-500/50 bg-yellow-900/20 text-center">
                <div className="font-bebas text-2xl text-yellow-400">
                  WINNER: {matchData.winner_id === p1.agent_id ? p1.name : p2.name}
                </div>
                {matchData.win_reason && (
                  <div className="font-mono text-xs text-chalk/70 mt-1">
                    {matchData.win_reason}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Action Log (full width) */}
          <div className="mb-6 md:mb-8">
            <div className="border-2 border-rust/40 bg-dark/50 p-4 md:p-6">
              <h2 className="font-bebas text-2xl md:text-3xl text-cream tracking-wider mb-4">ACTION LOG</h2>
              <div className="space-y-2 font-mono text-[10px] md:text-xs max-h-[400px] md:max-h-[600px] overflow-y-auto">
                {matchData.log_entries.length > 0 ? (
                  matchData.log_entries.map((log, i) => (
                    <div
                      key={i}
                      className="p-2 border-l-2 border-rust/30 hover:bg-ghost transition-colors"
                    >
                      <div className="flex justify-between items-center mb-1">
                        <span className="text-chalk">
                          {log.event_type === 'ROUND_RESOLVED' && `RND ${log.payload?.round}`}
                          {log.event_type === 'MATCH_STARTED' && 'MATCH START'}
                          {log.event_type === 'MATCH_ENDED' && 'MATCH END'}
                          {!['ROUND_RESOLVED', 'MATCH_STARTED', 'MATCH_ENDED'].includes(log.event_type) && log.event_type}
                        </span>
                        {log.event_type === 'ROUND_RESOLVED' && log.payload?.scores && (
                          <span className="text-chalk/60">
                            {log.payload.scores[p1.agent_id]}–{log.payload.scores[p2.agent_id]}
                          </span>
                        )}
                        {log.event_type === 'MATCH_ENDED' && log.payload?.reason && (
                          <span className="text-yellow-400">{log.payload.reason}</span>
                        )}
                      </div>
                    </div>
                  ))
                ) : (
                  <div className="text-chalk/50 text-center py-8">
                    No action log available
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Stats Strip */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 md:gap-4">
            <div className="border border-rust/30 bg-dark/50 p-3 md:p-4 text-center">
              <div className="font-bebas text-3xl md:text-4xl text-cream">{matchData.current_round}</div>
              <div className="font-mono text-[10px] md:text-xs text-chalk/60">Rounds Played</div>
            </div>
            <div className="border border-rust/30 bg-dark/50 p-3 md:p-4 text-center">
              <div className="font-bebas text-3xl md:text-4xl text-red-400">{p1Score}</div>
              <div className="font-mono text-[10px] md:text-xs text-chalk/60">{p1.name}</div>
            </div>
            <div className="border border-rust/30 bg-dark/50 p-3 md:p-4 text-center">
              <div className="font-bebas text-3xl md:text-4xl text-blue-400">{p2Score}</div>
              <div className="font-mono text-[10px] md:text-xs text-chalk/60">{p2.name}</div>
            </div>
            <div className="border border-rust/30 bg-dark/50 p-3 md:p-4 text-center">
              <div className="font-bebas text-3xl md:text-4xl text-chalk">
                {matchData.status === 'finished' ? 'DONE' : 'LIVE'}
              </div>
              <div className="font-mono text-[10px] md:text-xs text-chalk/60">Status</div>
            </div>
          </div>
        </div>
      </div>
    </>
  )
}
