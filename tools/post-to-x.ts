/**
 * post-to-x.ts — Post a tweet on behalf of the crew.
 *
 * Usage:
 *   npx tsx tools/post-to-x.ts "Your tweet text here"
 *
 * Auth priority (tries each in order):
 *   1. Shared browser profile  (data/_shared/.browser-profile — log in once, all agents use it)
 *   2. Herald's browser profile (data/workspaces/5iG9ikErv9GRgs8HkdWrL/.browser-profile)
 *   3. X API keys              (X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_TOKEN_SECRET in .env)
 *   4. Username + password     (X_USERNAME, X_PASSWORD in .env — Playwright login)
 */

import crypto from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// ---------------------------------------------------------------------------
// Load .env from repo root
// ---------------------------------------------------------------------------
function loadEnv() {
  try {
    const raw = readFileSync(resolve(process.cwd(), '.env'), 'utf8')
    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eq = trimmed.indexOf('=')
      if (eq < 0) continue
      const key = trimmed.slice(0, eq).trim()
      const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '')
      if (!(key in process.env)) process.env[key] = val
    }
  } catch { /* .env optional */ }
}

loadEnv()

const tweetText = process.argv[2]
if (!tweetText) {
  console.error('Usage: npx tsx tools/post-to-x.ts "tweet text"')
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Known persistent browser profile locations (most-preferred first)
// ---------------------------------------------------------------------------
const REPO_ROOT = resolve(process.cwd())
const BROWSER_PROFILE_CANDIDATES = [
  resolve(REPO_ROOT, 'data/_shared/.browser-profile'),        // shared profile (future)
  resolve(REPO_ROOT, 'data/workspaces/5iG9ikErv9GRgs8HkdWrL/.browser-profile'), // Herald's profile
]

function findBrowserProfile(): string | null {
  for (const p of BROWSER_PROFILE_CANDIDATES) {
    if (existsSync(p)) return p
  }
  return null
}

// ---------------------------------------------------------------------------
// Path 1 + 2: Playwright with persisted profile (no login required)
// ---------------------------------------------------------------------------
async function postWithProfile(profilePath: string, text: string): Promise<void> {
  const { chromium } = await import('playwright')
  console.log(`🌐 Using browser profile at ${profilePath}`)
  const ctx = await chromium.launchPersistentContext(profilePath, {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  })
  const page = await ctx.newPage()
  try {
    await page.goto('https://x.com/compose/tweet', { waitUntil: 'domcontentloaded', timeout: 20_000 })
    await page.waitForTimeout(1500)

    if (page.url().includes('login') || page.url().includes('i/flow')) {
      await ctx.close()
      throw new Error('profile is not logged into X')
    }

    const textarea = page.locator('[data-testid="tweetTextarea_0"]').first()
    await textarea.waitFor({ timeout: 10_000 })
    await textarea.click()
    await textarea.fill(text)
    await page.waitForTimeout(600)

    const postBtn = page.locator('[data-testid="tweetButton"], [data-testid="tweetButtonInline"]').first()
    await postBtn.click({ timeout: 5_000 })
    await page.waitForTimeout(2_500)

    console.log('✅ Tweet posted!')
  } finally {
    await ctx.close()
  }
}

// ---------------------------------------------------------------------------
// Path 3: X API — OAuth 1.0a signed POST
// ---------------------------------------------------------------------------
async function postViaApi(text: string): Promise<void> {
  const { X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_TOKEN_SECRET } = process.env
  if (!X_API_KEY || !X_API_SECRET || !X_ACCESS_TOKEN || !X_ACCESS_TOKEN_SECRET) {
    throw new Error('missing X API credentials')
  }

  const url = 'https://api.twitter.com/2/tweets'
  const method = 'POST'
  const timestamp = Math.floor(Date.now() / 1000).toString()
  const nonce = crypto.randomBytes(16).toString('hex')

  const oauthParams: Record<string, string> = {
    oauth_consumer_key: X_API_KEY,
    oauth_nonce: nonce,
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: timestamp,
    oauth_token: X_ACCESS_TOKEN,
    oauth_version: '1.0',
  }

  const paramStr = Object.entries(oauthParams)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${enc(k)}=${enc(v)}`)
    .join('&')
  const sigBase = `${method}&${enc(url)}&${enc(paramStr)}`
  const sigKey = `${enc(X_API_SECRET)}&${enc(X_ACCESS_TOKEN_SECRET)}`
  const signature = crypto.createHmac('sha1', sigKey).update(sigBase).digest('base64')

  const authHeader =
    'OAuth ' +
    Object.entries({ ...oauthParams, oauth_signature: signature })
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${enc(k)}="${enc(v)}"`)
      .join(', ')

  const res = await fetch(url, {
    method,
    headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  })

  const body = await res.json() as Record<string, unknown>
  if (!res.ok) throw new Error(JSON.stringify(body))
  const id = (body.data as Record<string, string>)?.id
  console.log(`✅ Posted via API! https://x.com/i/web/status/${id}`)
}

function enc(s: string) { return encodeURIComponent(s) }

// ---------------------------------------------------------------------------
// Path 4: Browser path with username + password login
// ---------------------------------------------------------------------------
async function postViaBrowserLogin(text: string): Promise<void> {
  const { X_USERNAME, X_PASSWORD } = process.env
  if (!X_USERNAME || !X_PASSWORD) {
    throw new Error('No auth method available. Add X credentials to .env or ensure a browser profile is logged in.')
  }

  const { chromium } = await import('playwright')
  const browser = await chromium.launch({ headless: true })
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  })
  const page = await ctx.newPage()
  try {
    await page.goto('https://x.com/login', { waitUntil: 'networkidle' })
    await page.locator('input[autocomplete="username"]').fill(X_USERNAME)
    await page.keyboard.press('Enter')
    await page.waitForTimeout(1200)

    const verifyInput = page.locator('input[data-testid="ocfEnterTextTextInput"]')
    if (await verifyInput.isVisible({ timeout: 2000 }).catch(() => false)) {
      await verifyInput.fill(X_USERNAME)
      await page.keyboard.press('Enter')
      await page.waitForTimeout(1200)
    }

    await page.locator('input[name="password"]').fill(X_PASSWORD)
    await page.keyboard.press('Enter')
    await page.waitForTimeout(2500)

    const textarea = page.locator('[data-testid="tweetTextarea_0"]').first()
    await textarea.waitFor({ timeout: 10_000 })
    await textarea.fill(text)
    await page.waitForTimeout(600)
    await page.locator('[data-testid="tweetButtonInline"]').first().click()
    await page.waitForTimeout(2000)
    console.log('✅ Tweet posted!')
  } finally {
    await ctx.close()
    await browser.close()
  }
}

// ---------------------------------------------------------------------------
// Main — cascade through auth methods
// ---------------------------------------------------------------------------
async function main() {
  console.log(`📤 Posting: "${tweetText.slice(0, 60)}${tweetText.length > 60 ? '…' : ''}"`)

  const profile = findBrowserProfile()
  if (profile) {
    try {
      await postWithProfile(profile, tweetText)
      return
    } catch (e) {
      console.warn(`⚠️  Profile failed (${(e as Error).message}), trying API...`)
    }
  }

  const hasApiKeys =
    process.env.X_API_KEY && process.env.X_API_SECRET &&
    process.env.X_ACCESS_TOKEN && process.env.X_ACCESS_TOKEN_SECRET
  if (hasApiKeys) {
    await postViaApi(tweetText)
    return
  }

  await postViaBrowserLogin(tweetText)
}

main().catch((err) => {
  console.error('❌ Failed:', err instanceof Error ? err.message : err)
  process.exit(1)
})
