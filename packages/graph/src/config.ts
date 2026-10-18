/**
 * Environment and domain constants.
 *
 * Nothing here encodes an airline rule that a query could decide instead.
 * These are generator parameters and connection settings only.
 */

import 'dotenv/config'

export interface Config {
  falkorUrl: string
  graphName: string
  /** Supplied separately when the credentials are not embedded in the URL. */
  username?: string
  password?: string
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const falkorUrl = overrides.falkorUrl ?? process.env.FALKOR_URL
  if (!falkorUrl) {
    throw new Error(
      'FALKOR_URL is not set. Copy .env.example to .env and paste the connection ' +
        'string from the FalkorDB Cloud UI. There is no fallback datastore.',
    )
  }

  // FALKOR_PASSWORD lets the password be pasted verbatim. Cloud passwords often
  // contain @ : / # ? or %, which silently corrupt a URL unless percent-encoded,
  // and the resulting failure reads as WRONGPASS rather than as a bad URL.
  const username = overrides.username ?? process.env.FALKOR_USERNAME
  const password = overrides.password ?? process.env.FALKOR_PASSWORD

  assertCredentialsPresent(falkorUrl, password)

  return {
    falkorUrl,
    graphName: overrides.graphName ?? process.env.GRAPH_NAME ?? 'slackline',
    ...(username ? { username } : {}),
    ...(password ? { password } : {}),
  }
}

/**
 * Catch the most common setup mistake — a connection string copied without its
 * password — before it reaches the server and comes back as a bare WRONGPASS.
 */
function assertCredentialsPresent(url: string, password: string | undefined): void {
  if (password) return

  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return // a malformed URL is the client's error to report, not ours
  }

  // Userinfo with a username but no password: "falkor://user@host:port".
  if (parsed.username && !parsed.password) {
    throw new Error(
      `FALKOR_URL has a username ("${parsed.username}") but no password.\n\n` +
        'Either paste the full string including the password:\n' +
        `  FALKOR_URL=falkor://${parsed.username}:YOUR_PASSWORD@${parsed.host}\n\n` +
        'or keep the URL as-is and set the password on its own line (safer — no\n' +
        'percent-encoding needed even if it contains @ : / # ? or %):\n' +
        '  FALKOR_PASSWORD=your-password-verbatim',
    )
  }
}

/* ------------------------------------------------------------------ */
/* Generator parameters — synthetic data only (hackathon Rule 6).      */
/* ------------------------------------------------------------------ */

/** Minimum aircraft turnaround, minutes. Generated parameter, not a regulation. */
export const MIN_TURN = 40

/** Minimum crew rest between legs, minutes. Generated parameter. */
export const MIN_REST = 45

/**
 * PLACEHOLDER — 13h. Must be confirmed against the DGCA FDTL CAR before this
 * number appears in the README, the video or any public claim.
 * See docs/AGENTS.md 8.8 and docs/kickoff.md 16.3.
 */
export const DUTY_LIMIT_MIN = 780

/** A delay above this many minutes counts as "delayed" when scoring passengers. */
export const SIGNIFICANT_DELAY_MIN = 15

/** Safety cap on the relaxation loop. Exceeding it means the graph has a cycle. */
export const MAX_RELAX_WAVES = 50

/**
 * Scoring weights. A declared heuristic, not a derived optimum.
 *
 *   score = pax_cancelled × 3  +  passenger-hours of delay × 1
 *
 * The delay term is weighted by BOTH how many passengers are affected and how
 * long each one waits. An earlier version scored delay per flight-minute
 * regardless of load, which made a 10-minute delay and a 3-hour delay on a full
 * aircraft nearly indistinguishable — and made the cancellation penalty so
 * dominant that no cancellation could ever improve the score, whatever it saved
 * downstream. The planner's only winning move was to do nothing.
 *
 * Three points per cancelled passenger against one per passenger-hour of delay
 * says: stranding someone outright is roughly as bad as delaying them 3 hours.
 * That ratio is a judgement call and is declared as such — it is not derived
 * from any airline's cost model.
 */
export const SCORE_WEIGHTS = {
  paxCancelled: 3,
  /** Per passenger-HOUR of delay (pax × delay minutes ÷ 60). */
  paxDelayHours: 1,
} as const
