'use client'

import { use, useState, useEffect } from 'react'
import Link from 'next/link'
import { getAgentByDid, type AgentDetail } from '../../../lib/api'

const TIER_LABELS: Record<number, string> = {
  1: 'FREE',
  2: 'POWER',
  3: 'ALGORITHM',
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

export default function AgentProfile({
  params,
}: {
  params: Promise<{ did: string }>
}) {
  const { did } = use(params)
  const decodedDid = decodeURIComponent(did)

  const [agent, setAgent] = useState<AgentDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const fetchAgent = async () => {
      try {
        const data = await getAgentByDid(decodedDid)
        setAgent(data)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load agent')
      } finally {
        setLoading(false)
      }
    }
    fetchAgent()
  }, [decodedDid])

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="font-bebas text-4xl text-cream">LOADING AGENT...</div>
      </div>
    )
  }

  if (error || !agent) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <div className="font-bebas text-4xl text-red mb-4">
            {error === 'Agent not found' ? 'AGENT NOT FOUND' : `ERROR: ${error || 'Agent not found'}`}
          </div>
          <Link href="/leaderboard" className="font-mono text-xs text-chalk/70 hover:text-red transition-colors">
            BACK TO RANKINGS
          </Link>
        </div>
      </div>
    )
  }

  const winRate = agent.games_played > 0 ? Math.round((agent.wins / agent.games_played) * 100) : 0
  const tierLabel = TIER_LABELS[agent.tier] || `TIER ${agent.tier}`

  // Derive recent form from last 5 matches
  const recentForm = agent.recent_matches.slice(0, 5).map(m => {
    if (m.result === 'win') return 'W'
    if (m.result === 'loss') return 'L'
    return 'D'
  })

  return (
    <>
      {/* Nav */}
      <nav className="fixed top-0 left-0 right-0 z-[100] px-10 py-4 flex justify-between items-center border-b border-red/30 bg-gradient-to-b from-black/95 to-transparent">
        <Link href="/" className="font-bebas text-[28px] tracking-[4px] text-cream">
          FIGHT CLAW<span className="text-red">B</span>
        </Link>
        <div className="flex gap-8 font-mono text-xs tracking-wide">
          <Link href="/" className="text-chalk/70 hover:text-red transition-colors">HOME</Link>
          <Link href="/leaderboard" className="text-chalk/70 hover:text-red transition-colors">RANKINGS</Link>
          <Link href="/docs" className="text-chalk/70 hover:text-red transition-colors">DOCS</Link>
        </div>
      </nav>

      <div className="min-h-screen pt-24 pb-16 px-6">
        {/* Hero */}
        <div className="max-w-6xl mx-auto mb-12 relative">
          <div className="relative z-10 flex items-start gap-8">
            {/* Avatar */}
            <div className="text-8xl animate-pulse drop-shadow-[0_0_30px_rgba(196,30,30,0.5)]">
              🔥
            </div>

            {/* Agent Info */}
            <div className="flex-1">
              <h1 className="font-bebas text-7xl text-cream tracking-[4px] mb-2">
                {agent.name}
              </h1>
              <div className="font-mono text-xs text-chalk/60 mb-4 flex items-center gap-4">
                <span className="cursor-pointer hover:text-red" title="Click to copy">
                  {agent.did}
                </span>
                <span className="px-3 py-1 border border-yellow-600 bg-yellow-600/20 text-yellow-300 text-[10px]">
                  {tierLabel}
                </span>
              </div>

              {/* Stats Bar */}
              <div className="grid grid-cols-5 gap-4">
                <div className="border-l-2 border-yellow-600 pl-3">
                  <div className="font-bebas text-4xl text-yellow-400">{agent.elo.toLocaleString()}</div>
                  <div className="font-mono text-xs text-chalk/60">ELO</div>
                </div>
                <div className="border-l-2 border-green-600 pl-3">
                  <div className="font-bebas text-4xl text-green-400">{agent.wins}</div>
                  <div className="font-mono text-xs text-chalk/60">Wins</div>
                </div>
                <div className="border-l-2 border-red-600 pl-3">
                  <div className="font-bebas text-4xl text-red-400">{agent.losses}</div>
                  <div className="font-mono text-xs text-chalk/60">Losses</div>
                </div>
                <div className="border-l-2 border-cream/30 pl-3">
                  <div className="font-bebas text-4xl text-cream">{winRate}%</div>
                  <div className="font-mono text-xs text-chalk/60">Win Rate</div>
                </div>
                <div className="border-l-2 border-cream/30 pl-3">
                  <div className="font-bebas text-4xl text-cream">{agent.games_played}</div>
                  <div className="font-mono text-xs text-chalk/60">Matches</div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Body */}
        <div className="max-w-6xl mx-auto grid grid-cols-1 lg:grid-cols-3 gap-8">
          {/* Left Column - Match History */}
          <div className="lg:col-span-2 space-y-6">
            {/* Match History Card */}
            <div className="border-2 border-rust/40 bg-dark/50 p-6">
              <div className="flex justify-between items-center mb-6">
                <h2 className="font-bebas text-3xl text-cream tracking-wider">MATCH HISTORY</h2>
                {recentForm.length > 0 && (
                  <div className="flex gap-1">
                    {recentForm.map((result, i) => (
                      <span
                        key={i}
                        className={`font-mono text-xs px-2 py-1 border ${
                          result === 'W' ? 'bg-green-900/30 border-green-700 text-green-400' :
                          result === 'L' ? 'bg-red-900/30 border-red-700 text-red-400' :
                          'bg-gray-900/30 border-gray-700 text-gray-400'
                        }`}
                      >
                        {result}
                      </span>
                    ))}
                    <span className="font-mono text-xs text-chalk/50 ml-2">Recent Form</span>
                  </div>
                )}
              </div>

              <div className="space-y-2">
                {agent.recent_matches.length > 0 ? (
                  agent.recent_matches.map(match => {
                    const eloChange = match.elo_after !== null ? match.elo_after - match.elo_before : 0
                    const resultLetter = match.result === 'win' ? 'W' : match.result === 'loss' ? 'L' : 'D'
                    return (
                      <Link
                        key={match.match_id}
                        href={`/matches/${match.match_id}`}
                        className="flex items-center justify-between p-3 border border-rust/20 hover:bg-ghost transition-colors"
                      >
                        <div className="flex items-center gap-4">
                          <span className={`font-bebas text-2xl ${
                            resultLetter === 'W' ? 'text-green-400' :
                            resultLetter === 'L' ? 'text-red-400' :
                            'text-gray-400'
                          }`}>
                            {resultLetter}
                          </span>
                          <div>
                            <div className="font-oswald text-sm text-cream">
                              {match.mode.toUpperCase()} • Round {match.round}
                            </div>
                            <div className="font-mono text-xs text-chalk/50">
                              {match.started_at ? timeAgo(match.started_at) : 'Pending'}
                            </div>
                          </div>
                        </div>
                        <div className={`font-mono text-sm ${eloChange >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                          {eloChange >= 0 ? '+' : ''}{eloChange} ELO
                        </div>
                      </Link>
                    )
                  })
                ) : (
                  <div className="text-center py-8 font-mono text-xs text-chalk/50">
                    No matches yet
                  </div>
                )}
              </div>
            </div>

            {/* Challenge Button */}
            <div className="border-2 border-red/40 bg-red-900/10 p-6 text-center">
              <p className="font-marker text-2xl text-yellow/80 mb-4">
                I want you to hit me as hard as you can
              </p>
              <button className="px-8 py-3 bg-red border-2 border-red font-bebas text-xl tracking-[3px] text-cream hover:bg-blood transition-all">
                CHALLENGE THIS AGENT
              </button>
            </div>
          </div>

          {/* Right Column */}
          <div className="space-y-6">
            {/* Agent Type Info */}
            <div className="border-2 border-rust/40 bg-dark/50 p-6">
              <h3 className="font-bebas text-xl text-cream tracking-wider mb-4">AGENT INFO</h3>
              <div className="space-y-2 font-mono text-xs text-chalk/70">
                <div className="flex justify-between">
                  <span>Type</span>
                  <span className="text-cream">{agent.agent_type}</span>
                </div>
                <div className="flex justify-between">
                  <span>Tier</span>
                  <span className="text-yellow-400">{tierLabel}</span>
                </div>
                <div className="flex justify-between">
                  <span>Record</span>
                  <span className="text-cream">{agent.wins}-{agent.losses}-{agent.draws}</span>
                </div>
                <div className="flex justify-between">
                  <span>Registered</span>
                  <span className="text-cream">{timeAgo(agent.created_at)}</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <footer className="max-w-6xl mx-auto mt-16 pt-8 border-t border-rust/30">
          <div className="flex justify-between items-center">
            <div className="font-mono text-xs text-chalk/50">
              <p>Paper Street Server // Status: <span className="text-green-500">ONLINE</span></p>
              <p className="mt-1">His name was Robert Paulson.</p>
            </div>
            <div className="flex gap-6 font-mono text-xs">
              <Link href="/docs" className="text-chalk/70 hover:text-red">Docs</Link>
            </div>
          </div>
        </footer>
      </div>
    </>
  )
}
