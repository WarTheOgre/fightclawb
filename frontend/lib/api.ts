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

export interface BattleParticipant {
  agent_id: string
  name: string
  elo_before: number
  elo_after: number | null
  slot: string
  home_row: number
  home_col: number
}

export interface BattleLogEntry {
  seq: number
  event_type: string
  payload: any
  prev_hash: string | null
  entry_hash: string
  created_at: string
}

export interface BattleDetail {
  match_id: string
  mode: string
  tier: number
  board_size: number
  status: string
  current_round: number
  win_reason: string | null
  winner_id: string | null
  participants: BattleParticipant[]
  started_at: string | null
  finished_at: string | null
  created_at: string
  latest_snapshot: { round: number; created_at: string } | null
  log_entries: BattleLogEntry[]
  log_length: number
}

export async function getBattle(matchId: string): Promise<BattleDetail> {
  const res = await fetch(`${API_BASE}/battles/${encodeURIComponent(matchId)}`)

  if (!res.ok) {
    throw new Error(`API error: ${res.status}`)
  }

  return res.json()
}

export interface RegisterRequest {
  name: string
  description?: string
  contact_email?: string
  agent_type?: 'standard' | 'code-bot' | 'webhook'
}

export interface RegisterResponse {
  agent_id: string
  did: string
  name: string
  agent_type: string
  tier: number
  elo: number
  api_key: string
  created_at: string
  status: string
  note: string
}

export interface AgentDetail {
  agent_id: string
  did: string
  name: string
  agent_type: string
  tier: number
  elo: number
  wins: number
  losses: number
  draws: number
  games_played: number
  win_rate: number
  recent_matches: {
    match_id: string
    mode: string
    status: string
    round: number
    win_reason: string | null
    started_at: string | null
    finished_at: string | null
    elo_before: number
    elo_after: number | null
    player_slot: string
    result: string
  }[]
  created_at: string
  updated_at: string
}

export interface BattleSummary {
  match_id: string
  status: string
  mode: string
  tier: number
  board_size: number
  current_round: number
  win_reason: string | null
  winner_id: string | null
  agent1: { agent_id: string; name: string; elo: number; elo_after: number | null; slot: string }
  agent2: { agent_id: string; name: string; elo: number; elo_after: number | null; slot: string }
  started_at: string | null
  finished_at: string | null
  created_at: string
}

export interface BattleListResponse {
  battles: BattleSummary[]
  total: number
}

export interface QueueResponse {
  status: string
  agent_id: string
  tier: number
  mode: string
  message: string
}

export async function registerAgent(data: RegisterRequest): Promise<RegisterResponse> {
  const res = await fetch(`${API_BASE}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
    throw new Error(err.error || `API error: ${res.status}`)
  }

  return res.json()
}

export async function joinQueue(agentId: string, mode: string = '1v1'): Promise<QueueResponse> {
  const res = await fetch(`${API_BASE}/queue`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent_id: agentId, mode }),
  })

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
    throw new Error(err.error || `API error: ${res.status}`)
  }

  return res.json()
}

export async function getBattles(params?: {
  agent_id?: string
  status?: string
  limit?: number
}): Promise<BattleListResponse> {
  const query = new URLSearchParams()
  if (params?.agent_id) query.set('agent_id', params.agent_id)
  if (params?.status) query.set('status', params.status)
  if (params?.limit) query.set('limit', params.limit.toString())

  const res = await fetch(`${API_BASE}/battles?${query}`)

  if (!res.ok) {
    throw new Error(`API error: ${res.status}`)
  }

  return res.json()
}

export async function getAgentDetail(agentId: string): Promise<AgentDetail> {
  const res = await fetch(`${API_BASE}/agents/${encodeURIComponent(agentId)}`)

  if (!res.ok) {
    throw new Error(`API error: ${res.status}`)
  }

  return res.json()
}

export async function getHealth() {
  const res = await fetch(`${API_BASE}/health`)
  return res.json()
}
