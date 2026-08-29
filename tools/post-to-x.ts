/**
 * post-to-x.ts — Post a tweet on behalf of the crew.
 *
 * Usage:
 *   npx tsx tools/post-to-x.ts "Your tweet text here"
 *
 * Auth — add ONE of these sets to your .env:
 *
 *   API path (preferred):
 *     X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_TOKEN_SECRET
 *
 *   Browser path (fallback):
 *     X_USERNAME, X_PASSWORD
 *
 * The script tries the API path first; falls back to Playwright if no API keys.
 */

import crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// ---------------------------------------------------------------------------
// Load .env from repo root (simple line-by-line parser, no dotenv dependency)
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
// API path — OAuth 1.0a signed POST to X v2
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

  // Build signature base string
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
    headers: {
      Authorization: authHeader,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ text }),
  })

  const body = await res.json() as Record<string, unknown>
  if (!res.ok) throw new Error(JSON.stringify(body))
  const id = (body.data as Record<string, string>)?.id
  console.log(`✅ Posted via API! https://x.com/i/web/status/${id}`)
}

function enc(s: string) {
  return encodeURIComponent(s)
}

// ---------------------------------------------------------------------------
// Browser path — Playwright headless Chromium
// ---------------------------------------------------------------------------
async function postViaBrowser(text: string): Promise<void> {
  const { X_USERNAME, X_PASSWORD } = process.env
  if (!X_USERNAME || !X_PASSWORD) {
    throw new Error(
      'No X API keys found and no X_USERNAME/X_PASSWORD. Add credentials to .env.'
    )
  }

  // Dynamic import so we don't crash if playwright isn't installed
  const { chromium } = await import('playwright')
  const browser = await chromium.launch({ headless: true })
  const ctx = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  })
  const page = await ctx.newPage()

  try {
    console.log('🌐 Opening x.com/login ...')
    await page.goto('https://x.com/login', { waitUntil: 'networkidle' })

    // Username step
    await page.locator('input[autocomplete="username"]').fill(X_USERNAME)
    await page.keyboard.press('Enter')
    await page.waitForTimeout(1200)

    // Password step (might have an email/phone verification screen first)
    const passwordInput = page.locator('input[name="password"]')
    const verifyInput = page.locator('input[data-testid="ocfEnterTextTextInput"]')
    if (await verifyInput.isVisible({ timeout: 2000 }).catch(() => false)) {
      // X asked for email/phone verification — fill username again
      await verifyInput.fill(X_USERNAME)
      await page.keyboard.press('Enter')
      await page.waitForTimeout(1200)
    }
    await passwordInput.fill(X_PASSWORD)
    await page.keyboard.press('Enter')
    await page.waitForTimeout(2500)

    // Compose tweet
    console.log('✍️  Composing tweet ...')
    await page.locator('[data-testid="tweetTextarea_0"]').fill(text)
    await page.waitForTimeout(800)

    // Post it
    await page.locator('[data-testid="tweetButtonInline"]').click()
    await page.waitForTimeout(2000)

    console.log('✅ Tweet posted via browser!')
  } finally {
    await browser.close()
  }
}

// ---------------------------------------------------------------------------
// Main — try API first, fall back to browser
// ---------------------------------------------------------------------------
async function main() {
  console.log(`📤 Posting: "${tweetText.slice(0, 60)}${tweetText.length > 60 ? '…' : ''}"`)

  const hasApiKeys =
    process.env.X_API_KEY &&
    process.env.X_API_SECRET &&
    process.env.X_ACCESS_TOKEN &&
    process.env.X_ACCESS_TOKEN_SECRET

  if (hasApiKeys) {
    await postViaApi(tweetText)
  } else {
    console.log('ℹ️  No API keys — trying browser automation ...')
    await postViaBrowser(tweetText)
  }
}

main().catch((err) => {
  console.error('❌ Failed:', err instanceof Error ? err.message : err)
  process.exit(1)
})
