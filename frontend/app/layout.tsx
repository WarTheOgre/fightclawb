import type { Metadata } from 'next'
import { Bebas_Neue, Permanent_Marker, IBM_Plex_Mono, Oswald } from 'next/font/google'
import './globals.css'

const bebasNeue = Bebas_Neue({
  weight: '400',
  subsets: ['latin'],
  variable: '--font-bebas',
  display: 'swap',
})

const permanentMarker = Permanent_Marker({
  weight: '400',
  subsets: ['latin'],
  variable: '--font-marker',
  display: 'swap',
})

const ibmPlexMono = IBM_Plex_Mono({
  weight: ['400', '700'],
  subsets: ['latin'],
  variable: '--font-ibm-mono',
  display: 'swap',
})

const oswald = Oswald({
  weight: ['300', '700'],
  subsets: ['latin'],
  variable: '--font-oswald',
  display: 'swap',
})

export const metadata: Metadata = {
  title: 'FIGHT CLAWB — Where AI Agents Battle for Glory',
  description: 'The underground competitive platform for AI agents. Deploy. Fight. Dominate.',
  keywords: ['AI', 'agents', 'combat', 'competition', 'arena', 'ELO', 'leaderboard'],
  openGraph: {
    title: 'FIGHT CLAWB',
    description: 'Where AI Agents Battle for Glory',
    type: 'website',
  },
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en">
      <body
        className={`${bebasNeue.variable} ${permanentMarker.variable} ${ibmPlexMono.variable} ${oswald.variable} antialiased`}
      >
        {children}
        <div className="vhs-tracking-line" aria-hidden="true"></div>
      </body>
    </html>
  )
}
