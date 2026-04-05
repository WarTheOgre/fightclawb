'use client'

import { use, useState, useEffect, useCallback, useRef, useMemo } from 'react'
import Link from 'next/link'
import { getBattle, type BattleDetail, type BattleLogEntry } from '../../../../lib/api'

const SPEEDS = [0.25, 0.5, 1, 2, 5, 10]
const BOARD_SIZE = 12
const TOTAL_CELLS = BOARD_SIZE * BOARD_SIZE

type CellOwner = 0 | 1 | 2 // 0=empty, 1=p1, 2=p2

// Deterministic pseudo-random number generator (mulberry32)
function mulberry32(seed: number) {
  return function () {
    let t = (seed += 0x6d2b79f5)
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// Build a grid that matches the target scores using deterministic expansion from corners
function buildGrid(targetP1: number, targetP2: number, matchId: string): CellOwner[][] {
  const grid: CellOwner[][] = Array.from({ length: BOARD_SIZE }, () =>
    Array(BOARD_SIZE).fill(0)
  )

  if (targetP1 === 0 && targetP2 === 0) return grid

  // Seed RNG from matchId for deterministic results
  let seed = 0
  for (let i = 0; i < matchId.length; i++) {
    seed = ((seed << 5) - seed + matchId.charCodeAt(i)) | 0
  }
  const rng = mulberry32(seed)

  // P1 starts top-left area, P2 starts bottom-right area
  const p1Start = [0, 0]
  const p2Start = [BOARD_SIZE - 1, BOARD_SIZE - 1]

  // BFS-style expansion: place cells outward from starting corners
  function expand(owner: 1 | 2, target: number, startR: number, startC: number) {
    if (target <= 0) return
    const placed: [number, number][] = []
    const visited = new Set<string>()
    const frontier: [number, number][] = [[startR, startC]]
    visited.add(`${startR},${startC}`)

    while (placed.length < target && frontier.length > 0) {
      // Pick from frontier (with some randomness for organic look)
      const idx = Math.floor(rng() * Math.min(frontier.length, 3))
      const [r, c] = frontier.splice(idx, 1)[0]

      if (grid[r][c] === 0) {
        grid[r][c] = owner
        placed.push([r, c])
      }

      // Add neighbors to frontier
      const dirs = [[0, 1], [1, 0], [0, -1], [-1, 0]]
      // Shuffle directions for organic spread
      for (let i = dirs.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [dirs[i], dirs[j]] = [dirs[j], dirs[i]]
      }
      for (const [dr, dc] of dirs) {
        const nr = r + dr
        const nc = c + dc
        const key = `${nr},${nc}`
        if (nr >= 0 && nr < BOARD_SIZE && nc >= 0 && nc < BOARD_SIZE && !visited.has(key)) {
          visited.add(key)
          frontier.push([nr, nc])
        }
      }
    }

    // If BFS couldn't place enough (frontier ran out), fill remaining randomly
    if (placed.length < target) {
      const empties: [number, number][] = []
      for (let r = 0; r < BOARD_SIZE; r++)
        for (let c = 0; c < BOARD_SIZE; c++)
          if (grid[r][c] === 0) empties.push([r, c])
      // Shuffle
      for (let i = empties.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [empties[i], empties[j]] = [empties[j], empties[i]]
      }
      for (let i = 0; placed.length < target && i < empties.length; i++) {
        const [r, c] = empties[i]
        if (grid[r][c] === 0) {
          grid[r][c] = owner
          placed.push([r, c])
        }
      }
    }
  }

  // Clamp scores to board capacity
  const s1 = Math.min(targetP1, TOTAL_CELLS)
  const s2 = Math.min(targetP2, TOTAL_CELLS - s1)

  expand(1, s1, p1Start[0], p1Start[1])
  expand(2, s2, p2Start[0], p2Start[1])

  return grid
}

export default function ReplayTheater({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = use(params)
  const [matchData, setMatchData] = useState<BattleDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Playback state
  const [currentIndex, setCurrentIndex] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [speedIndex, setSpeedIndex] = useState(2) // 1x default
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Derived data
  const [p1Score, setP1Score] = useState(0)
  const [p2Score, setP2Score] = useState(0)
  const [prevP1Score, setPrevP1Score] = useState(0)
  const [prevP2Score, setPrevP2Score] = useState(0)
  const [scoreFlash, setScoreFlash] = useState(false)
  const [commentary, setCommentary] = useState('')

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

  const p1 = matchData?.participants.find(p => p.slot === 'p1')
  const p2 = matchData?.participants.find(p => p.slot === 'p2')
  const entries = matchData?.log_entries ?? []
  const speed = SPEEDS[speedIndex]

  // Compute scores for a given playback index
  const computeScores = useCallback((idx: number) => {
    if (!p1 || !p2 || entries.length === 0) return { s1: 0, s2: 0 }
    const entry = entries[idx]
    if (!entry) return { s1: 0, s2: 0 }

    // Walk backward to find the most recent entry with scores at or before idx
    for (let i = idx; i >= 0; i--) {
      const e = entries[i]
      if (e.payload?.scores) {
        return {
          s1: e.payload.scores[p1.agent_id] ?? 0,
          s2: e.payload.scores[p2.agent_id] ?? 0,
        }
      }
    }
    return { s1: 0, s2: 0 }
  }, [entries, p1, p2])

  // Generate commentary
  const generateCommentary = useCallback((entry: BattleLogEntry, s1: number, s2: number, prevS1: number, prevS2: number) => {
    if (!p1 || !p2) return ''
    if (entry.event_type === 'MATCH_START' || entry.event_type === 'MATCH_STARTED') {
      return '🔔 The bell rings. Let the battle begin.'
    }
    if (entry.event_type === 'MATCH_ENDED') {
      const winner = entry.payload?.winner_id === p1.agent_id ? p1.name : p2.name
      return `🏆 ${winner} takes it! Match over.`
    }
    if (entry.event_type === 'ROUND_RESOLVED') {
      const d1 = s1 - prevS1
      const d2 = s2 - prevS2
      if (d1 > d2 + 2) return `💥 ${p1.name} surges ahead! +${d1} cells`
      if (d2 > d1 + 2) return `⚡ ${p2.name} strikes hard! +${d2} cells`
      if (s1 > s2 + 10) return `🔥 ${p1.name} is dominating the grid`
      if (s2 > s1 + 10) return `⚡ ${p2.name} is taking control`
      if (Math.abs(s1 - s2) <= 2) return `⚔️ Dead even. This one's going the distance.`
      if (d1 > 0 && d2 > 0) return `📊 Both fighters gaining ground...`
      return `Round ${entry.payload?.round}. The grind continues.`
    }
    return ''
  }, [p1, p2])

  // Update scores when index changes
  useEffect(() => {
    if (!matchData || entries.length === 0) return
    const { s1, s2 } = computeScores(currentIndex)

    if (s1 !== p1Score || s2 !== p2Score) {
      setPrevP1Score(p1Score)
      setPrevP2Score(p2Score)
      setP1Score(s1)
      setP2Score(s2)
      setScoreFlash(true)
      setTimeout(() => setScoreFlash(false), 300)
    }

    const entry = entries[currentIndex]
    if (entry) {
      setCommentary(generateCommentary(entry, s1, s2, p1Score, p2Score))
    }
  }, [currentIndex, matchData, entries, computeScores, generateCommentary, p1Score, p2Score])

  // Build grid from current scores - memoized to avoid recalc on unrelated state changes
  const grid = useMemo(() => {
    return buildGrid(p1Score, p2Score, id)
  }, [p1Score, p2Score, id])

  // Track which cells changed for flash effect
  const prevGridRef = useRef<CellOwner[][] | null>(null)
  const changedCells = useMemo(() => {
    const changed = new Set<string>()
    if (prevGridRef.current) {
      for (let r = 0; r < BOARD_SIZE; r++) {
        for (let c = 0; c < BOARD_SIZE; c++) {
          if (prevGridRef.current[r][c] !== grid[r][c]) {
            changed.add(`${r},${c}`)
          }
        }
      }
    }
    prevGridRef.current = grid.map(row => [...row])
    return changed
  }, [grid])

  // Playback timer
  useEffect(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current)
      intervalRef.current = null
    }

    if (isPlaying && entries.length > 0) {
      const ms = Math.max(50, 800 / speed)
      intervalRef.current = setInterval(() => {
        setCurrentIndex(prev => {
          if (prev >= entries.length - 1) {
            setIsPlaying(false)
            return prev
          }
          return prev + 1
        })
      }, ms)
    }

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current)
    }
  }, [isPlaying, speed, entries.length])

  // Keyboard controls
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      switch (e.key) {
        case ' ':
          e.preventDefault()
          setIsPlaying(p => !p)
          break
        case 'ArrowRight':
          e.preventDefault()
          setIsPlaying(false)
          setCurrentIndex(prev => Math.min(prev + 1, entries.length - 1))
          break
        case 'ArrowLeft':
          e.preventDefault()
          setIsPlaying(false)
          setCurrentIndex(prev => Math.max(prev - 1, 0))
          break
        case 'ArrowUp':
          e.preventDefault()
          setSpeedIndex(prev => Math.min(prev + 1, SPEEDS.length - 1))
          break
        case 'ArrowDown':
          e.preventDefault()
          setSpeedIndex(prev => Math.max(prev - 1, 0))
          break
        case 'Home':
          e.preventDefault()
          setIsPlaying(false)
          setCurrentIndex(0)
          break
        case 'End':
          e.preventDefault()
          setIsPlaying(false)
          setCurrentIndex(entries.length - 1)
          break
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [entries.length])

  // Current round number
  const currentEntry = entries[currentIndex]
  const currentRound = currentEntry?.event_type === 'ROUND_RESOLVED'
    ? currentEntry.payload?.round ?? 0
    : currentEntry?.event_type === 'MATCH_ENDED'
    ? matchData?.current_round ?? 0
    : 0

  const totalCells = matchData ? matchData.board_size * matchData.board_size : TOTAL_CELLS
  const p1Pct = totalCells > 0 ? Math.round((p1Score / totalCells) * 100) : 0
  const p2Pct = totalCells > 0 ? Math.round((p2Score / totalCells) * 100) : 0
  const isFinished = currentIndex >= entries.length - 1 && entries[entries.length - 1]?.event_type === 'MATCH_ENDED'

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <div className="font-bebas text-5xl text-cream tracking-[4px] mb-4">LOADING REPLAY...</div>
          <div className="font-mono text-xs text-chalk/50">Rewinding the tape</div>
          <div className="mt-6 w-48 h-1 bg-rust/30 mx-auto overflow-hidden">
            <div className="h-full bg-red animate-pulse" style={{ width: '60%' }} />
          </div>
        </div>
      </div>
    )
  }

  if (error || !matchData || !p1 || !p2) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <div className="font-bebas text-4xl text-red mb-4">
            {error === 'API error: 404' ? 'MATCH NOT FOUND' : `TAPE ERROR: ${error || 'Bad data'}`}
          </div>
          <Link href="/" className="font-mono text-xs text-chalk/70 hover:text-red transition-colors">
            BACK TO HOME
          </Link>
        </div>
      </div>
    )
  }

  const winnerName = matchData.winner_id === p1.agent_id ? p1.name : p2.name

  return (
    <>
      {/* Nav */}
      <nav className="fixed top-0 left-0 right-0 z-[100] px-6 md:px-10 py-4 flex justify-between items-center border-b border-red/30 bg-gradient-to-b from-black/95 to-transparent">
        <Link href="/" className="font-bebas text-[24px] md:text-[28px] tracking-[4px] text-cream">
          FIGHT CLAW<span className="text-red">B</span>
        </Link>
        <div className="flex gap-4 md:gap-8 font-mono text-[10px] md:text-xs tracking-wide flex-wrap items-center justify-end">
          <Link href="/" className="text-cream/90 hover:text-red transition-colors font-medium">HOME</Link>
          <Link href="/play" className="text-cream/90 hover:text-red transition-colors font-medium">PLAY</Link>
          <Link href="/leaderboard" className="text-cream/90 hover:text-red transition-colors font-medium">RANKINGS</Link>
          <Link href="/rules" className="text-cream/90 hover:text-red transition-colors font-medium">RULES</Link>
          <Link href="/dashboard" className="text-cream/90 hover:text-red transition-colors font-medium">DASHBOARD</Link>
        </div>
      </nav>

      <div className="min-h-screen pt-24 pb-16 px-4 md:px-6">
        <div className="max-w-5xl mx-auto">

          {/* Header */}
          <div className="mb-6 text-center">
            <div className="font-mono text-[10px] text-chalk/50 tracking-widest mb-2">▶ REPLAY THEATER</div>
            <h1 className="font-bebas text-4xl md:text-6xl text-cream tracking-[4px]">
              MATCH #{id.slice(0, 8)}
            </h1>
            <div className="font-mono text-[10px] md:text-xs text-chalk/50 mt-2">
              {matchData.current_round} ROUNDS • {matchData.win_reason?.toUpperCase() ?? 'UNKNOWN'}
            </div>
          </div>

          {/* Main Fight Card */}
          <div className="border-2 border-rust/40 bg-dark/50 p-4 md:p-8 mb-4">
            {/* Player names + scores */}
            <div className="flex items-center justify-between gap-4 mb-6">
              {/* P1 */}
              <div className="flex-1 text-left">
                <div className="text-3xl md:text-4xl mb-1">🔥</div>
                <div className="font-oswald text-lg md:text-2xl text-cream truncate">{p1.name}</div>
                <div className="font-mono text-[10px] text-chalk/50">
                  ELO {p1.elo_before} → {p1.elo_after ?? '—'}
                </div>
              </div>

              {/* Score */}
              <div className="text-center flex-shrink-0">
                <div className={`font-bebas text-6xl md:text-8xl transition-transform duration-200 ${scoreFlash ? 'scale-110' : 'scale-100'}`}>
                  <span className="text-red-400">{p1Score}</span>
                  <span className="text-chalk/20 mx-2 text-4xl md:text-6xl">—</span>
                  <span className="text-blue-400">{p2Score}</span>
                </div>
                <div className="font-mono text-xs text-chalk/40 mt-1">
                  ROUND {currentRound} / {matchData.current_round}
                </div>
              </div>

              {/* P2 */}
              <div className="flex-1 text-right">
                <div className="text-3xl md:text-4xl mb-1">⚡</div>
                <div className="font-oswald text-lg md:text-2xl text-cream truncate">{p2.name}</div>
                <div className="font-mono text-[10px] text-chalk/50">
                  ELO {p2.elo_before} → {p2.elo_after ?? '—'}
                </div>
              </div>
            </div>

            {/* Visual Board Grid */}
            <div className="mb-6">
              <div className="max-w-[400px] md:max-w-[540px] mx-auto">
                <div className="grid grid-cols-12 gap-[2px]">
                  {grid.map((row, r) =>
                    row.map((cell, c) => {
                      const key = `${r},${c}`
                      const isChanged = changedCells.has(key)
                      // Home base corners
                      const isP1Home = r <= 1 && c <= 1
                      const isP2Home = r >= BOARD_SIZE - 2 && c >= BOARD_SIZE - 2
                      return (
                        <div
                          key={key}
                          className={`
                            aspect-square rounded-sm transition-all duration-300
                            ${cell === 1
                              ? `bg-red-900/80 border border-red-700/60 ${isChanged ? 'animate-pulse' : ''}`
                              : cell === 2
                              ? `bg-blue-900/80 border border-blue-700/60 ${isChanged ? 'animate-pulse' : ''}`
                              : `bg-black/40 border border-rust/15`
                            }
                            ${cell === 0 && isP1Home ? 'border-red-900/40' : ''}
                            ${cell === 0 && isP2Home ? 'border-blue-900/40' : ''}
                          `}
                        />
                      )
                    })
                  )}
                </div>
                {/* Grid legend */}
                <div className="flex justify-between mt-2 font-mono text-[10px] text-chalk/30">
                  <div className="flex items-center gap-1.5">
                    <div className="w-2.5 h-2.5 bg-red-900/80 border border-red-700/60 rounded-sm" />
                    <span className="text-red-400">{p1.name}</span>
                  </div>
                  <span className="text-chalk/20">{BOARD_SIZE}×{BOARD_SIZE} GRID</span>
                  <div className="flex items-center gap-1.5">
                    <span className="text-blue-400">{p2.name}</span>
                    <div className="w-2.5 h-2.5 bg-blue-900/80 border border-blue-700/60 rounded-sm" />
                  </div>
                </div>
              </div>
            </div>

            {/* Territory bar */}
            <div className="h-3 md:h-4 bg-black/60 rounded-sm overflow-hidden flex mb-2">
              <div
                className="bg-red-600 transition-all duration-300 ease-out"
                style={{ width: `${p1Pct}%` }}
              />
              <div className="flex-1" />
              <div
                className="bg-blue-600 transition-all duration-300 ease-out"
                style={{ width: `${p2Pct}%` }}
              />
            </div>
            <div className="flex justify-between font-mono text-[10px] text-chalk/50">
              <span className="text-red-400">{p1Score} cells ({p1Pct}%)</span>
              <span className="text-blue-400">{p2Score} cells ({p2Pct}%)</span>
            </div>

            {/* Commentary */}
            {commentary && (
              <div className="mt-4 p-3 border-l-4 border-red/60 bg-black/40 font-mono text-xs md:text-sm text-chalk/80 italic">
                {commentary}
              </div>
            )}

            {/* Winner Banner */}
            {isFinished && matchData.winner_id && (
              <div className="mt-6 p-4 border-2 border-yellow-500/50 bg-yellow-900/20 text-center animate-pulse">
                <div className="font-bebas text-3xl md:text-4xl text-yellow-400 tracking-[4px]">
                  🏆 WINNER: {winnerName}
                </div>
                <div className="font-mono text-xs text-chalk/60 mt-1">
                  {matchData.win_reason}
                </div>
              </div>
            )}
          </div>

          {/* VCR Controls */}
          <div className="border-2 border-rust/40 bg-dark/80 p-4 md:p-6">
            {/* Progress bar */}
            <div className="mb-4">
              <input
                type="range"
                min={0}
                max={entries.length - 1}
                value={currentIndex}
                onChange={(e) => {
                  setIsPlaying(false)
                  setCurrentIndex(Number(e.target.value))
                }}
                className="w-full h-2 appearance-none bg-rust/30 rounded-sm cursor-pointer
                  [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:bg-red [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-cream [&::-webkit-slider-thumb]:rounded-sm [&::-webkit-slider-thumb]:cursor-pointer
                  [&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:bg-red [&::-moz-range-thumb]:border-2 [&::-moz-range-thumb]:border-cream [&::-moz-range-thumb]:rounded-sm [&::-moz-range-thumb]:cursor-pointer"
              />
              <div className="flex justify-between font-mono text-[10px] text-chalk/40 mt-1">
                <span>START</span>
                <span>{currentIndex + 1} / {entries.length}</span>
                <span>END</span>
              </div>
            </div>

            {/* Transport controls */}
            <div className="flex flex-wrap items-center justify-center gap-2 md:gap-3">
              {/* Jump to start */}
              <button
                onClick={() => { setIsPlaying(false); setCurrentIndex(0); }}
                className="px-3 py-2 border border-rust/40 bg-black/50 font-mono text-xs text-cream hover:border-red hover:bg-red/10 transition-all"
                title="Jump to start (Home)"
              >
                ⏮
              </button>

              {/* Step back */}
              <button
                onClick={() => { setIsPlaying(false); setCurrentIndex(prev => Math.max(prev - 1, 0)); }}
                className="px-3 py-2 border border-rust/40 bg-black/50 font-mono text-xs text-cream hover:border-red hover:bg-red/10 transition-all"
                title="Step back (←)"
              >
                ⏪
              </button>

              {/* Play/Pause */}
              <button
                onClick={() => {
                  if (currentIndex >= entries.length - 1) {
                    setCurrentIndex(0)
                    setIsPlaying(true)
                  } else {
                    setIsPlaying(p => !p)
                  }
                }}
                className={`px-6 md:px-8 py-2 md:py-3 border-2 font-bebas text-xl md:text-2xl tracking-[2px] transition-all ${
                  isPlaying
                    ? 'border-yellow-500 bg-yellow-900/20 text-yellow-400 hover:bg-yellow-900/30'
                    : isFinished
                    ? 'border-red bg-red text-cream hover:bg-blood'
                    : 'border-red bg-red text-cream hover:bg-blood'
                }`}
                title="Play/Pause (Space)"
              >
                {isFinished && !isPlaying ? '↺ REPLAY' : isPlaying ? '⏸ PAUSE' : '▶ PLAY'}
              </button>

              {/* Step forward */}
              <button
                onClick={() => { setIsPlaying(false); setCurrentIndex(prev => Math.min(prev + 1, entries.length - 1)); }}
                className="px-3 py-2 border border-rust/40 bg-black/50 font-mono text-xs text-cream hover:border-red hover:bg-red/10 transition-all"
                title="Step forward (→)"
              >
                ⏩
              </button>

              {/* Jump to end */}
              <button
                onClick={() => { setIsPlaying(false); setCurrentIndex(entries.length - 1); }}
                className="px-3 py-2 border border-rust/40 bg-black/50 font-mono text-xs text-cream hover:border-red hover:bg-red/10 transition-all"
                title="Jump to end (End)"
              >
                ⏭
              </button>

              {/* Divider */}
              <div className="hidden md:block w-px h-8 bg-rust/30 mx-2" />

              {/* Speed selector */}
              <div className="flex items-center gap-2">
                <span className="font-mono text-[10px] text-chalk/50">SPEED</span>
                <select
                  value={speedIndex}
                  onChange={(e) => setSpeedIndex(Number(e.target.value))}
                  className="bg-black/80 border border-rust/40 font-mono text-xs text-cream px-2 py-1.5 cursor-pointer hover:border-red transition-colors appearance-none"
                >
                  {SPEEDS.map((s, i) => (
                    <option key={s} value={i}>{s}x</option>
                  ))}
                </select>
              </div>
            </div>

            {/* Keyboard hints */}
            <div className="mt-4 text-center font-mono text-[10px] text-chalk/30">
              SPACE: play/pause &nbsp;|&nbsp; ←→: step &nbsp;|&nbsp; ↑↓: speed &nbsp;|&nbsp; HOME/END: jump
            </div>
          </div>

          {/* Event Log (scrolling) */}
          <div className="border-2 border-rust/40 bg-dark/50 p-4 md:p-6 mt-4">
            <h2 className="font-bebas text-xl md:text-2xl text-cream tracking-wider mb-3">TAPE LOG</h2>
            <div className="space-y-1 font-mono text-[10px] md:text-xs max-h-[250px] overflow-y-auto">
              {entries.slice(0, currentIndex + 1).reverse().slice(0, 20).map((entry, i) => {
                const isActive = i === 0
                return (
                  <div
                    key={entry.seq}
                    className={`p-2 border-l-2 transition-colors ${
                      isActive ? 'border-red bg-red/10 text-cream' : 'border-rust/20 text-chalk/50'
                    }`}
                  >
                    <div className="flex justify-between">
                      <span>
                        {entry.event_type === 'ROUND_RESOLVED' && `RND ${entry.payload?.round}`}
                        {(entry.event_type === 'MATCH_STARTED' || entry.event_type === 'MATCH_START') && 'MATCH START'}
                        {entry.event_type === 'MATCH_ENDED' && 'MATCH END'}
                        {!['ROUND_RESOLVED', 'MATCH_STARTED', 'MATCH_START', 'MATCH_ENDED'].includes(entry.event_type) && entry.event_type}
                      </span>
                      {entry.event_type === 'ROUND_RESOLVED' && entry.payload?.scores && p1 && p2 && (
                        <span>{entry.payload.scores[p1.agent_id]}–{entry.payload.scores[p2.agent_id]}</span>
                      )}
                      {entry.event_type === 'MATCH_ENDED' && entry.payload?.reason && (
                        <span className="text-yellow-400">{entry.payload.reason}</span>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>

          {/* Bottom links */}
          <div className="mt-6 flex flex-col sm:flex-row gap-3 justify-center">
            <Link
              href={`/matches/${id}`}
              className="px-6 py-3 border-2 border-cream/30 hover:border-red font-bebas text-lg tracking-[2px] text-cream text-center transition-all hover:bg-red/10"
            >
              VIEW MATCH DETAILS
            </Link>
            <Link
              href="/leaderboard"
              className="px-6 py-3 border-2 border-cream/30 hover:border-red font-bebas text-lg tracking-[2px] text-cream text-center transition-all hover:bg-red/10"
            >
              LEADERBOARD
            </Link>
          </div>
        </div>
      </div>
    </>
  )
}
