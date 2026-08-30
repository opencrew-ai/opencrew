/**
 * Public read-only channel transcript export.
 *
 * GET /share/channels/:channelId
 *   Returns a self-contained, no-auth HTML page of the channel's messages.
 *   Designed to be dropped as a link in a Show HN comment, tweet, or PR.
 *
 * The route intentionally has no auth guard — it's a PUBLIC share page.
 * Only non-private channels are exportable; private channels return 403.
 *
 * URL is intentionally under /share/ (not /api/) so it renders in a browser
 * without any extra content-type gymnastics.
 */

import type { FastifyInstance } from 'fastify'
import { and, asc, eq, isNull } from 'drizzle-orm'
import type { AppContext } from '../context'
import { agents, channels, messages, users } from '../db/schema'

const MAX_EXPORT_MESSAGES = 500

export function registerExportRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/share/channels/:channelId', async (req, reply) => {
    const { channelId } = req.params as { channelId: string }

    const [channel] = await ctx.db
      .select()
      .from(channels)
      .where(eq(channels.id, channelId))
      .limit(1)

    if (!channel) return reply.code(404).type('text/html').send(errorPage('Channel not found.'))
    if (channel.isPrivate) return reply.code(403).type('text/html').send(errorPage('This channel is private.'))

    const rows = await ctx.db
      .select()
      .from(messages)
      .where(and(eq(messages.channelId, channelId), isNull(messages.threadRootId)))
      .orderBy(asc(messages.createdAt))
      .limit(MAX_EXPORT_MESSAGES)

    // Resolve author names for all messages in one pass
    const authorCache = new Map<string, { name: string; emoji: string }>()

    const resolved = await Promise.all(
      rows.map(async (msg) => {
        const cacheKey = `${msg.authorType}:${msg.authorId}`
        if (!authorCache.has(cacheKey)) {
          let name = 'OpenCrew'
          let emoji = '⚙️'
          if (msg.authorType === 'human' && msg.authorId) {
            const [u] = await ctx.db.select().from(users).where(eq(users.id, msg.authorId)).limit(1)
            name = u?.name ?? 'Human'
            emoji = '👤'
          } else if (msg.authorType === 'agent' && msg.authorId) {
            const [a] = await ctx.db.select().from(agents).where(eq(agents.id, msg.authorId)).limit(1)
            name = a?.name ?? 'Agent'
            emoji = a?.avatarEmoji ?? '🤖'
          }
          authorCache.set(cacheKey, { name, emoji })
        }
        const author = authorCache.get(cacheKey)!
        return { msg, author }
      })
    )

    const html = buildHtml(channel.name, resolved)
    return reply.type('text/html').send(html)
  })
}

// ─── HTML builder ───────────────────────────────────────────────────────────

function esc(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true
  })
}

/** Very light markdown: bold, inline code, code blocks, @mentions */
function renderContent(raw: string): string {
  // Escape HTML first, then selectively un-escape for our own markup
  let s = esc(raw)
  // Code blocks
  s = s.replace(/```[\s\S]*?```/g, (m) => `<pre class="code">${m.slice(3, -3)}</pre>`)
  // Inline code
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>')
  // Bold
  s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
  // @mentions
  s = s.replace(/@(\w+)/g, '<span class="mention">@$1</span>')
  // Line breaks
  s = s.replace(/\n/g, '<br>')
  return s
}

/** OpenCrew brand mark, inlined so exports are self-contained single files. */
const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="20" height="20" role="img" aria-label="OpenCrew"><rect width="64" height="64" rx="14" fill="#0F1412"/><g fill="none" stroke="#FFFFFF" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M22 17 L16.5 17 L16.5 47 L22 47"/><path d="M42 17 L47.5 17 L47.5 47 L42 47"/></g><g stroke="#FFFFFF" stroke-width="1.6" stroke-opacity="0.6" stroke-linecap="round"><line x1="29.03" y1="29.03" x2="24.48" y2="24.48"/><line x1="34.97" y1="29.03" x2="39.52" y2="24.48"/><line x1="29.03" y1="34.97" x2="24.48" y2="39.52"/><line x1="34.97" y1="34.97" x2="39.52" y2="39.52"/></g><g fill="#FFFFFF"><circle cx="22.5" cy="22.5" r="2.8"/><circle cx="41.5" cy="22.5" r="2.8"/><circle cx="22.5" cy="41.5" r="2.8"/><circle cx="41.5" cy="41.5" r="2.8"/></g><circle cx="32" cy="32" r="4.2" fill="#FFFFFF"/></svg>`

interface ResolvedMessage {
  msg: { id: string; content: string; createdAt: number; authorType: string }
  author: { name: string; emoji: string }
}

function buildHtml(channelName: string, rows: ResolvedMessage[]): string {
  const msgs = rows
    .map(({ msg, author }) => {
      const isAgent = msg.authorType === 'agent'
      const roleClass = isAgent ? 'msg-agent' : 'msg-human'
      return `
      <div class="msg ${roleClass}" id="msg-${esc(msg.id)}">
        <div class="avatar">${esc(author.emoji)}</div>
        <div class="body">
          <div class="meta">
            <span class="name">${esc(author.name)}</span>
            <span class="time">${formatTime(msg.createdAt)}</span>
          </div>
          <div class="content">${renderContent(msg.content)}</div>
        </div>
      </div>`
    })
    .join('\n')

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>#${esc(channelName)} — opencrew</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #0f0f12;
      color: #e4e4e7;
      line-height: 1.6;
      padding-bottom: 80px;
    }
    .header {
      position: sticky; top: 0; z-index: 10;
      background: #18181b;
      border-bottom: 1px solid #27272a;
      padding: 14px 24px;
      display: flex; align-items: center; gap: 16px;
    }
    .header h1 { font-size: 15px; font-weight: 600; color: #fff; }
    .header .sub { font-size: 12px; color: #71717a; }
    .logo svg { width: 24px; height: 24px; display: block; }
    .badge {
      margin-left: auto;
      font-size: 11px;
      padding: 3px 10px;
      border: 1px solid #3f3f46;
      border-radius: 9999px;
      color: #71717a;
      text-decoration: none;
    }
    .badge:hover { color: #d4d4d8; border-color: #52525b; }
    .feed { max-width: 800px; margin: 0 auto; padding: 24px 16px; }
    .msg {
      display: flex; gap: 12px;
      padding: 10px 12px;
      border-radius: 8px;
      margin-bottom: 2px;
    }
    .msg:hover { background: #18181b; }
    .msg-agent .name { color: #a78bfa; }
    .msg-human .name { color: #60a5fa; }
    .avatar { font-size: 22px; flex-shrink: 0; width: 32px; text-align: center; padding-top: 1px; }
    .body { flex: 1; min-width: 0; }
    .meta { display: flex; align-items: baseline; gap: 10px; margin-bottom: 2px; }
    .name { font-weight: 600; font-size: 14px; }
    .time { font-size: 11px; color: #52525b; }
    .content { font-size: 14px; color: #d4d4d8; word-wrap: break-word; white-space: pre-wrap; }
    code { background: #27272a; padding: 1px 5px; border-radius: 4px; font-size: 13px; font-family: "SF Mono", "Fira Code", monospace; color: #a3e635; }
    pre.code { background: #18181b; border: 1px solid #27272a; border-radius: 6px; padding: 12px 14px; margin: 8px 0; overflow-x: auto; font-size: 13px; font-family: "SF Mono", "Fira Code", monospace; color: #d4d4d8; white-space: pre; }
    .mention { color: #818cf8; font-weight: 500; }
    .footer { text-align: center; margin-top: 48px; font-size: 12px; color: #3f3f46; }
    .footer a { color: #52525b; }
    @media (max-width: 600px) { .feed { padding: 12px 8px; } }
  </style>
</head>
<body>
  <div class="header">
    <span class="logo">${LOGO_SVG}</span>
    <div>
      <h1>#${esc(channelName)}</h1>
      <div class="sub">opencrew — read-only transcript · ${rows.length} messages</div>
    </div>
    <a class="badge" href="https://opencrew.run" target="_blank">opencrew.run ↗</a>
  </div>
  <div class="feed">
    ${msgs}
    <div class="footer">
      <p>Generated by <a href="https://opencrew.run">opencrew</a> · ${new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}</p>
    </div>
  </div>
</body>
</html>`
}

function errorPage(msg: string): string {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>opencrew</title></head>
<body style="font-family:sans-serif;background:#0f0f12;color:#e4e4e7;padding:48px;text-align:center">
  <p style="font-size:18px;display:flex;align-items:center;justify-content:center;gap:8px">${LOGO_SVG} opencrew</p>
  <p style="margin-top:16px;color:#71717a">${esc(msg)}</p>
</body></html>`
}
