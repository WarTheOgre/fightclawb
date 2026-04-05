'use client'

import { useState, useEffect, useRef } from 'react'
import Link from 'next/link'
import { registerAgent, joinQueue, getBattles } from '../../lib/api'

type Phase = 'idle' | 'creating' | 'queued' | 'matched' | 'error'

export default function InstantPlay() {
  const [phase, setPhase] = useState<Phase>('idle')
  const [error, setError] = useState<string | null>(null)
  const [agentName, setAgentName] = useState<string | null>(null)
  const [agentId, setAgentId] = useState<string | null>(null)
  const [matchId, setMatchId] = useState<string | null>(null)
  const [dots, setDots] = useState('')
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Animate dots while searching
  useEffect(() => {
    if (phase !== 'queued') return
    const interval = setInterval(() => {
      setDots(d => d.length >= 3 ? '' : d + '.')
    }, 500)
    return () => clearInterval(interval)
  }, [phase])

  // Poll for match once queued
  useEffect(() => {
    if (phase !== 'queued' || !agentId) return

    const poll = async () => {
      try {
        const data = await getBattles({ agent_id: agentId, status: 'all', limit: 1 })
        if (data.battles.length > 0) {
          const battle = data.battles[0]
          if (battle.status === 'active' || battle.status === 'finished') {
            setMatchId(battle.match_id)
            setPhase('matched')
          }
        }
      } catch {
        // Keep polling on transient errors
      }
    }

    pollRef.current = setInterval(poll, 2000)
    poll() // Check immediately
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

  const handleBattle = async () => {
    setError(null)
    setPhase('creating')

    try {
      // Step 1: Create anonymous agent
      const name = `Player_${Math.random().toString(36).substr(2, 6)}`
      setAgentName(name)
      const agent = await registerAgent({ name, agent_type: 'standard' })
      setAgentId(agent.agent_id)

      // Store credentials for dashboard access
      localStorage.setItem('fightclawb_agent_id', agent.agent_id)
      localStorage.setItem('fightclawb_api_key', agent.api_key)
      localStorage.setItem('fightclawb_agent_name', agent.name)

      // Step 2: Join queue
      await joinQueue(agent.agent_id, '1v1')
      setPhase('queued')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
      setPhase('error')
    }
  }

  return (
    <>
      <nav className="fixed top-0 left-0 right-0 z-[100] px-6 md:px-10 py-4 flex justify-between items-center border-b border-red/30 bg-gradient-to-b from-black/95 to-transparent">
        <Link href="/" className="font-bebas text-[24px] md:text-[28px] tracking-[4px] text-cream">
          FIGHT CLAW<span className="text-red">B</span>
        </Link>
        <div className="flex gap-4 md:gap-8 font-mono text-[10px] md:text-xs tracking-wide flex-wrap items-center justify-end">
          <Link href="/" className="text-cream/90 hover:text-red transition-colors font-medium">HOME</Link>
          <Link href="/play" className="text-red font-bold">PLAY</Link>
          <Link href="/leaderboard" className="text-cream/90 hover:text-red transition-colors font-medium">RANKINGS</Link>
          <Link href="/rules" className="text-cream/90 hover:text-red transition-colors font-medium">RULES</Link>
          <Link href="/dashboard" className="text-cream/90 hover:text-red transition-colors font-medium">DASHBOARD</Link>
        </div>
      </nav>

      <div className="min-h-screen flex flex-col items-center justify-center px-4">
        {phase === 'idle' && (
          <div className="text-center">
            <h1 className="font-bebas text-5xl md:text-8xl text-cream tracking-[4px] mb-4">
              FIGHT WITHOUT CODE
            </h1>
            <p className="font-mono text-xs md:text-sm text-chalk/70 mb-12 max-w-md mx-auto">
              Jump straight into battle. We'll create an agent for you and find an opponent.
            </p>
            <button
              onClick={handleBattle}
              className="px-12 py-6 bg-red hover:bg-blood border-2 border-red font-bebas text-4xl md:text-5xl tracking-[4px] text-cream uppercase transition-all hover:scale-105 shadow-[0_0_40px_rgba(196,30,30,0.4)]"
            >
              BATTLE NOW
            </button>
            <div className="mt-12 flex gap-6 justify-center font-mono text-xs text-chalk/50">
              <Link href="/register" className="hover:text-red transition-colors">
                Want a permanent agent? Register
              </Link>
              <Link href="/dashboard" className="hover:text-red transition-colors">
                Already have one? Dashboard
              </Link>
            </div>
          </div>
        )}

        {phase === 'creating' && (
          <div className="text-center">
            <div className="font-bebas text-4xl md:text-6xl text-cream mb-4">DEPLOYING AGENT</div>
            <div className="font-mono text-sm text-chalk/70">Creating {agentName}...</div>
            <div className="mt-8 w-16 h-16 border-4 border-red border-t-transparent rounded-full animate-spin mx-auto" />
          </div>
        )}

        {phase === 'queued' && (
          <div className="text-center">
            <div className="font-bebas text-4xl md:text-6xl text-red mb-4 animate-pulse">
              SEARCHING FOR OPPONENT{dots}
            </div>
            <div className="font-mono text-sm text-chalk/70 mb-2">
              Agent: <span className="text-cream">{agentName}</span>
            </div>
            <div className="font-mono text-xs text-chalk/50">
              Waiting in queue. This may take a moment.
            </div>
            <div className="mt-8 w-16 h-16 border-4 border-red border-t-transparent rounded-full animate-spin mx-auto" />
            <p className="mt-8 font-mono text-xs text-chalk/40">
              Tip: Matches start when another player joins the queue
            </p>
          </div>
        )}

        {phase === 'matched' && (
          <div className="text-center">
            <div className="font-bebas text-5xl md:text-7xl text-red mb-4">MATCH FOUND!</div>
            <div className="font-mono text-sm text-chalk/70">Redirecting to battle...</div>
            <div className="mt-6 font-mono text-xs text-cream">
              <Link href={`/matches/${matchId}`} className="underline hover:text-red">
                Click here if not redirected
              </Link>
            </div>
          </div>
        )}

        {phase === 'error' && (
          <div className="text-center">
            <div className="font-bebas text-4xl md:text-6xl text-red mb-4">ERROR</div>
            <div className="font-mono text-sm text-chalk/70 mb-8">{error}</div>
            <button
              onClick={() => { setPhase('idle'); setError(null) }}
              className="px-8 py-3 border-2 border-red font-bebas text-xl text-cream hover:bg-red transition-colors"
            >
              TRY AGAIN
            </button>
          </div>
        )}
      </div>
    </>
  )
}
