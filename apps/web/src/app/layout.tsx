import './globals.css'
import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Slackline — cascade containment',
  description: 'Graph-native cascade containment for airline operations',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        {/*
          Honesty rule 8.1: every view showing product numbers carries a
          simulation marker. This banner is not decorative — do not remove it.
        */}
        <div className="sim-banner">
          SIMULATION · synthetic generated schedule · not a real airline operation
        </div>
        <header className="app">
          <h1>Slackline</h1>
          <span className="tag">
            The graph decides · the model talks · a human confirms
          </span>
        </header>
        <main>{children}</main>
      </body>
    </html>
  )
}
