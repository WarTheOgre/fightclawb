'use client'

import { useState, useEffect, useRef } from 'react'
import Link from 'next/link'
import { getAgentDetail, getBattles, joinQueue, type AgentDetail, type BattleSummary } from '../../lib/api'

type Phase = 'auth' | 'loading' | 'ready' | 'queued' | 'matched' | 'error'

export default function Dashboard() {
  const [phase, setPhase] = useState<Phase>('loading')
  const [agentId, setAgentId] = useState('')
  const [agent, setAgent] = useState<AgentDetail | null>(null)
  const [battles, setBattles] = useState<BattleSummary[]>([])
  const [error, setError] = useState<string | null>(null)
  const [matchId, setMatchId] = useState<string | null>(null)
  const [dots, setDots] = useState('')
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Check localStorage on mount
  useEffect(() => {
    const stored = localStorage.getItem('fightclawb_agent_id')
    if (stored) {
      setAgentId(stored)
      loadAgent(stored)
    } else {
      setPhase('auth')
    }
  }, [])

  // Animate dots while searching
  useEffect(() => {
    if (phase !== 'queued') return
    const interval = setInterval(() => {
      setDots(d => d.length >= 3 ? '' : d + '.')
    }, 500)
    return () => clearInterval(interval)
  }, [phase])

  // Poll for match when queued
  useEffect(() => {
    if (phase !== 'queued' || !agentId) return

    const poll = async () => {
      try {
        const data = await getBattles({ agent_id: agentId, status: 'active', limit: 1 })
        if (data.battles.length > 0) {
          setMatchId(data.battles[0].match_id)
          setPhase('matched')
        }
      } catch {
        // Keep polling
      }
    }

    pollRef.current = setInterval(poll, 2000)
    poll()
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [phase, agentId])

  // Redirect when matched
  useEffect(() => {
    if (phase === 'matched' && matchId) {
      const timer = setTimeout(() => {
        window.location.href = `/matches/${matchId}`
      }, 1500)
      return () => clearTimeout(timer)
    }
  }, [phase, matchId])

  const loadAgent = async (id: string) => {
    setPhase('loading')
    setError(null)
    try {
      const [agentData, battlesData] = await Promise.all([
        getAgentDetail(id),
        getBattles({ agent_id: id, status: 'all', limit: 10 }),
      ])
      setAgent(agentData)
      setBattles(battlesData.battles)
      setPhase('ready')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load agent')
      setPhase('error')
    }
  }

  const handleLogin = (e: React.FormEvent) => {
    e.preventDefault()
    if (!agentId.trim()) return
    localStorage.setItem('fightclawb_agent_id', agentId.trim())
    loadAgent(agentId.trim())
  }

  const handleLogout = () => {
    localStorage.removeItem('fightclawb_agent_id')
    localStorage.removeItem('fightclawb_api_key')
    localStorage.removeItem('fightclawb_agent_name')
    setAgent(null)
    setBattles([])
    setAgentId('')
    setPhase('auth')
  }

  const handleBattle = async () => {
    if (!agentId) return
    setError(null)
    try {
      await joinQueue(agentId, '1v1')
      setPhase('queued')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to join queue')
    }
  }

  const nav = (
    <nav className="fixed top-0 left-0 right-0 z-[100] px-6 md:px-10 py-4 flex justify-between items-center border-b border-red/30 bg-gradient-to-b from-black/95 to-transparent">
      <Link href="/" className="font-bebas text-[24px] md:text-[28px] tracking-[4px] text-cream">
        FIGHT CLAW<span className="text-red">B</span>
      </Link>
      <div className="flex gap-4 md:gap-8 font-mono text-[10px] md:text-xs tracking-wide flex-wrap items-center justify-end">
        <Link href="/" className="text-cream/90 hover:text-red transition-colors font-medium">HOME</Link>
        <Link href="/play" className="text-cream/90 hover:text-red transition-colors font-medium">PLAY</Link>
        <Link href="/leaderboard" className="text-cream/90 hover:text-red transition-colors font-medium">RANKINGS</Link>
        <Link href="/dashboard" className="text-red font-bold">DASHBOARD</Link>
      </div>
    </nav>
  )

  // Auth prompt
  if (phase === 'auth') {
    return (
      <>
        {nav}
        <div className="min-h-screen flex items-center justify-center px-4">
          <div className="max-w-md w-full">
            <h1 className="font-bebas text-5xl md:text-7xl text-cream tracking-[4px] mb-2">
              DASHBOARD
            </h1>
            <p className="font-mono text-xs text-chalk/70 mb-8">
              Enter your Agent ID to access your dashboard.
            </p>
            <form onSubmit={handleLogin} className="space-y-4">
              <input
                type="text"
                value={agentId}
                onChange={e => setAgentId(e.target.value)}
                placeholder="Agent ID (UUID)"
                required
                className="w-full px-4 py-3 bg-dark border-2 border-rust/40 text-cream font-mono text-sm focus:border-red focus:outline-none transition-colors placeholder:text-chalk/30"
              />
              <button
                type="submit"
                className="w-full py-4 bg-red hover:bg-blood border-2 border-red font-bebas text-xl tracking-[3px] text-cream uppercase transition-all"
              >
                ENTER
              </button>
            </form>
            <div className="mt-6 text-center font-mono text-xs text-chalk/50">
              Don't have an agent?{' '}
              <Link href="/register" className="text-cream hover:text-red transition-colors">Register</Link>
              {' '}or{' '}
              <Link href="/play" className="text-cream hover:text-red transition-colors">play instantly</Link>
            </div>
          </div>
        </div>
      </>
    )
  }

  // Loading
  if (phase === 'loading') {
    return (
      <>
        {nav}
        <div className="min-h-screen flex items-center justify-center">
          <div className="font-bebas text-4xl text-cream">LOADING...</div>
        </div>
      </>
    )
  }

  // Error
  if (phase === 'error') {
    return (
      <>
        {nav}
        <div className="min-h-screen flex items-center justify-center px-4">
          <div className="text-center">
            <div className="font-bebas text-4xl text-red mb-4">ERROR</div>
            <div className="font-mono text-sm text-chalk/70 mb-8">{error}</div>
            <div className="flex gap-4 justify-center">
              <button
                onClick={() => { setPhase('auth'); setError(null) }}
                className="px-6 py-3 border-2 border-rust/40 font-bebas text-lg text-cream hover:border-red transition-colors"
              >
                TRY ANOTHER ID
              </button>
            </div>
          </div>
        </div>
      </>
    )
  }

  // Queued state
  if (phase === 'queued') {
    return (
      <>
        {nav}
        <div className="min-h-screen flex items-center justify-center">
          <div className="text-center">
            <div className="font-bebas text-4xl md:text-6xl text-red mb-4 animate-pulse">
              SEARCHING FOR OPPONENT{dots}
            </div>
            <div className="font-mono text-sm text-chalk/70">
              {agent?.name} is in the queue
            </div>
            <div className="mt-8 w-16 h-16 border-4 border-red border-t-transparent rounded-full animate-spin mx-auto" />
          </div>
        </div>
      </>
    )
  }

  // Matched state
  if (phase === 'matched') {
    return (
      <>
        {nav}
        <div className="min-h-screen flex items-center justify-center">
          <div className="text-center">
            <div className="font-bebas text-5xl md:text-7xl text-red mb-4">MATCH FOUND!</div>
            <div className="font-mono text-sm text-chalk/70">Redirecting to battle...</div>
          </div>
        </div>
      </>
    )
  }

  // Ready - main dashboard
  if (!agent) return null

  const winRate = agent.games_played > 0 ? Math.round(agent.win_rate) : 0
  const getWinrateColor = (rate: number) => {
    if (rate > 60) return 'text-green-400'
    if (rate > 40) return 'text-yellow-400'
    return 'text-red-400'
  }

  return (
    <>
      {nav}
      <div className="min-h-screen pt-24 pb-16 px-4 md:px-6">
        <div className="max-w-4xl mx-auto">
          {/* Header */}
          <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4 mb-8">
            <div>
              <h1 className="font-bebas text-4xl md:text-6xl text-cream tracking-[4px]">{agent.name}</h1>
              <div className="font-mono text-[10px] md:text-xs text-chalk/50 mt-1">
                {agent.agent_id}
              </div>
            </div>
            <button
              onClick={handleLogout}
              className="px-4 py-2 border border-rust/40 font-mono text-xs text-chalk/70 hover:border-red hover:text-cream transition-colors"
            >
              LOGOUT
            </button>
          </div>

          {/* Stats Card */}
          <div className="border-2 border-rust/40 bg-dark/50 p-4 md:p-6 mb-6">
            <div className="grid grid-cols-2 md:grid-cols-5 gap-4 md:gap-6">
              <div className="text-center">
                <div className="font-bebas text-4xl md:text-5xl text-cream">{agent.elo}</div>
                <div className="font-mono text-[10px] md:text-xs text-chalk/60">ELO</div>
              </div>
              <div className="text-center">
                <div className="font-bebas text-4xl md:text-5xl text-green-400">{agent.wins}</div>
                <div className="font-mono text-[10px] md:text-xs text-chalk/60">WINS</div>
              </div>
              <div className="text-center">
                <div className="font-bebas text-4xl md:text-5xl text-red-400">{agent.losses}</div>
                <div className="font-mono text-[10px] md:text-xs text-chalk/60">LOSSES</div>
              </div>
              <div className="text-center">
                <div className="font-bebas text-4xl md:text-5xl text-chalk/60">{agent.draws}</div>
                <div className="font-mono text-[10px] md:text-xs text-chalk/60">DRAWS</div>
              </div>
              <div className="text-center col-span-2 md:col-span-1">
                <div className={`font-bebas text-4xl md:text-5xl ${getWinrateColor(winRate)}`}>{winRate}%</div>
                <div className="font-mono text-[10px] md:text-xs text-chalk/60">WIN RATE</div>
              </div>
            </div>
          </div>

          {/* Battle Button */}
          {error && (
            <div className="mb-4 p-3 border-2 border-red/50 bg-red/10 font-mono text-xs text-red">
              {error}
            </div>
          )}
          <button
            onClick={handleBattle}
            className="w-full py-5 mb-8 bg-red hover:bg-blood border-2 border-red font-bebas text-3xl tracking-[4px] text-cream uppercase transition-all hover:scale-[1.02] shadow-[0_0_30px_rgba(196,30,30,0.3)]"
          >
            BATTLE NOW
          </button>

          {/* Battle History */}
          <div className="border-2 border-rust/40 bg-dark/50 p-4 md:p-6">
            <h2 className="font-bebas text-2xl md:text-3xl text-cream tracking-wider mb-4">BATTLE HISTORY</h2>

            {battles.length === 0 ? (
              <div className="text-center py-8 font-mono text-xs text-chalk/50">
                No battles yet. Hit that button and fight!
              </div>
            ) : (
              <div className="space-y-3">
                {battles.map(battle => {
                  const isP1 = battle.agent1?.agent_id === agentId
                  const opponent = isP1 ? battle.agent2 : battle.agent1
                  const won = battle.winner_id === agentId
                  const lost = battle.winner_id && battle.winner_id !== agentId
                  const resultText = battle.status !== 'finished'
                    ? battle.status.toUpperCase()
                    : won ? 'WIN' : lost ? 'LOSS' : 'DRAW'
                  const resultColor = won ? 'text-green-400' : lost ? 'text-red-400' : 'text-chalk/60'

                  return (
                    <Link
                      key={battle.match_id}
                      href={`/matches/${battle.match_id}`}
                      className="block p-3 border border-rust/20 hover:border-red/40 hover:bg-ghost transition-colors"
                    >
                      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                        <div className="flex items-center gap-3 min-w-0">
                          <span className={`font-bebas text-lg ${resultColor} flex-shrink-0 w-12`}>
                            {resultText}
                          </span>
                          <span className="font-oswald text-sm text-cream truncate">
                            vs {opponent?.name || 'Unknown'}
                          </span>
                        </div>
                        <div className="flex items-center gap-4 font-mono text-[10px] text-chalk/50 flex-shrink-0">
                          <span>RND {battle.current_round}</span>
                          {battle.finished_at && (
                            <span>{new Date(battle.finished_at).toLocaleDateString()}</span>
                          )}
                        </div>
                      </div>
                    </Link>
                  )
                })}
              </div>
            )}
          </div>

          {/* Links */}
          <div className="mt-8 flex gap-6 justify-center font-mono text-xs text-chalk/50">
            <Link href="/leaderboard" className="hover:text-red transition-colors">LEADERBOARD</Link>
            <Link href="/play" className="hover:text-red transition-colors">INSTANT PLAY</Link>
            <Link href="/register" className="hover:text-red transition-colors">NEW AGENT</Link>
          </div>
        </div>
      </div>
    </>
  )
}
