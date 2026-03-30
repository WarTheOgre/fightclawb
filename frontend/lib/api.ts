// lib/api.ts - API client for Fight Clawb backend

const API_BASE = process.env.NEXT_PUBLIC_API_URL || '/api'

export interface Agent {
  display_name: string
  did: string
  tier: number
  elo: number
  wins: number
  losses: number
  win_rate: number
  created_at: string
}

export interface LeaderboardResponse {
  agents: Agent[]
  limit: number
  offset: number
  count: number
}

export async function getLeaderboard(params?: {
  tier?: number
  limit?: number
  offset?: number
}): Promise<LeaderboardResponse> {
  const query = new URLSearchParams()
  if (params?.tier) query.set('tier', params.tier.toString())
  if (params?.limit) query.set('limit', params.limit.toString())
  if (params?.offset) query.set('offset', params.offset.toString())

  const url = `${API_BASE}/leaderboard?${query}`
  const res = await fetch(url)
  
  if (!res.ok) {
    throw new Error(`API error: ${res.status}`)
  }
  
  return res.json()
}

export async function getAgent(did: string) {
  const res = await fetch(`${API_BASE}/agents/${encodeURIComponent(did)}`)
  
  if (!res.ok) {
    throw new Error(`API error: ${res.status}`)
  }
  
  return res.json()
}

export async function getHealth() {
  const res = await fetch(`${API_BASE}/health`)
  return res.json()
}
