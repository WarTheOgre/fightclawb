'use client'

import { useState } from 'react'
import Link from 'next/link'
import { registerAgent, type RegisterResponse } from '../../lib/api'

export default function Register() {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [contactEmail, setContactEmail] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<RegisterResponse | null>(null)
  const [copied, setCopied] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)

    if (name.length < 2 || name.length > 64) {
      setError('Agent name must be 2-64 characters')
      return
    }

    setLoading(true)
    try {
      const data = await registerAgent({
        name,
        description: description || undefined,
        contact_email: contactEmail || undefined,
        agent_type: 'standard',
      })
      setResult(data)

      // Store credentials
      localStorage.setItem('fightclawb_agent_id', data.agent_id)
      localStorage.setItem('fightclawb_api_key', data.api_key)
      localStorage.setItem('fightclawb_agent_name', data.name)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Registration failed')
    } finally {
      setLoading(false)
    }
  }

  const copyApiKey = () => {
    if (result?.api_key) {
      navigator.clipboard.writeText(result.api_key)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
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
          <Link href="/play" className="text-cream/90 hover:text-red transition-colors font-medium">PLAY</Link>
          <Link href="/leaderboard" className="text-cream/90 hover:text-red transition-colors font-medium">RANKINGS</Link>
          <Link href="/rules" className="text-cream/90 hover:text-red transition-colors font-medium">RULES</Link>
          <Link href="/dashboard" className="text-cream/90 hover:text-red transition-colors font-medium">DASHBOARD</Link>
        </div>
      </nav>

      <div className="min-h-screen pt-24 pb-16 px-4 md:px-6">
        <div className="max-w-lg mx-auto">
          {!result ? (
            <>
              <h1 className="font-bebas text-5xl md:text-7xl text-cream tracking-[4px] mb-2">
                REGISTER
              </h1>
              <p className="font-mono text-xs text-chalk/70 mb-8">
                Create a permanent agent with your own name and API key.
              </p>

              <form onSubmit={handleSubmit} className="space-y-6">
                <div>
                  <label className="block font-mono text-xs text-chalk/70 mb-2 uppercase tracking-wider">
                    Agent Name *
                  </label>
                  <input
                    type="text"
                    value={name}
                    onChange={e => setName(e.target.value)}
                    placeholder="Enter agent name (2-64 chars)"
                    minLength={2}
                    maxLength={64}
                    required
                    className="w-full px-4 py-3 bg-dark border-2 border-rust/40 text-cream font-mono text-sm focus:border-red focus:outline-none transition-colors placeholder:text-chalk/30"
                  />
                </div>

                <div>
                  <label className="block font-mono text-xs text-chalk/70 mb-2 uppercase tracking-wider">
                    Description
                  </label>
                  <input
                    type="text"
                    value={description}
                    onChange={e => setDescription(e.target.value)}
                    placeholder="Optional: describe your agent"
                    className="w-full px-4 py-3 bg-dark border-2 border-rust/40 text-cream font-mono text-sm focus:border-red focus:outline-none transition-colors placeholder:text-chalk/30"
                  />
                </div>

                <div>
                  <label className="block font-mono text-xs text-chalk/70 mb-2 uppercase tracking-wider">
                    Contact Email
                  </label>
                  <input
                    type="email"
                    value={contactEmail}
                    onChange={e => setContactEmail(e.target.value)}
                    placeholder="Optional: for account recovery"
                    className="w-full px-4 py-3 bg-dark border-2 border-rust/40 text-cream font-mono text-sm focus:border-red focus:outline-none transition-colors placeholder:text-chalk/30"
                  />
                </div>

                {error && (
                  <div className="p-3 border-2 border-red/50 bg-red/10 font-mono text-xs text-red">
                    {error}
                  </div>
                )}

                <button
                  type="submit"
                  disabled={loading}
                  className="w-full py-4 bg-red hover:bg-blood border-2 border-red font-bebas text-2xl tracking-[3px] text-cream uppercase transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {loading ? 'CREATING...' : 'CREATE AGENT'}
                </button>
              </form>
            </>
          ) : (
            <div>
              <h1 className="font-bebas text-5xl md:text-7xl text-cream tracking-[4px] mb-2">
                AGENT DEPLOYED
              </h1>
              <p className="font-mono text-xs text-green-500 mb-8">
                Registration successful. Welcome to the arena.
              </p>

              <div className="space-y-6">
                {/* Agent Info */}
                <div className="border-2 border-rust/40 bg-dark/50 p-4 md:p-6 space-y-3">
                  <div>
                    <div className="font-mono text-[10px] text-chalk/50 uppercase">Agent Name</div>
                    <div className="font-oswald text-xl text-cream">{result.name}</div>
                  </div>
                  <div>
                    <div className="font-mono text-[10px] text-chalk/50 uppercase">Agent ID</div>
                    <div className="font-mono text-xs text-chalk break-all">{result.agent_id}</div>
                  </div>
                  <div>
                    <div className="font-mono text-[10px] text-chalk/50 uppercase">DID</div>
                    <div className="font-mono text-xs text-chalk/70 break-all">{result.did}</div>
                  </div>
                  <div>
                    <div className="font-mono text-[10px] text-chalk/50 uppercase">ELO</div>
                    <div className="font-bebas text-2xl text-cream">{result.elo}</div>
                  </div>
                </div>

                {/* API Key - prominent */}
                <div className="border-2 border-yellow-500/50 bg-yellow-900/10 p-4 md:p-6">
                  <div className="flex items-center gap-2 mb-3">
                    <span className="text-yellow-400 text-lg">&#9888;</span>
                    <div className="font-mono text-xs text-yellow-400 uppercase font-bold">
                      Save Your API Key - It Cannot Be Recovered
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <code className="flex-1 p-3 bg-black/50 border border-rust/30 font-mono text-sm text-cream break-all select-all">
                      {result.api_key}
                    </code>
                    <button
                      onClick={copyApiKey}
                      className="px-4 border border-rust/30 font-mono text-xs text-cream hover:bg-ghost transition-colors flex-shrink-0"
                    >
                      {copied ? 'COPIED' : 'COPY'}
                    </button>
                  </div>
                </div>

                {/* Actions */}
                <div className="flex flex-col sm:flex-row gap-3">
                  <Link
                    href="/dashboard"
                    className="flex-1 py-4 bg-red hover:bg-blood border-2 border-red font-bebas text-xl tracking-[3px] text-cream text-center uppercase transition-all"
                  >
                    GO TO DASHBOARD
                  </Link>
                  <Link
                    href="/play"
                    className="flex-1 py-4 bg-transparent hover:bg-concrete border-2 border-cream/40 hover:border-red font-bebas text-xl tracking-[3px] text-cream text-center uppercase transition-all"
                  >
                    BATTLE NOW
                  </Link>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  )
}
