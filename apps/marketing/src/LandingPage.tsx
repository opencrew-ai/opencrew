import { Logo } from './components/Logo'
import { Monogram } from './components/Monogram'

export function LandingPage() {
  return (
    <div className="min-h-screen bg-[#0a0c0b] text-zinc-200">
      {/* Nav */}
      <nav className="mx-auto flex max-w-6xl items-center justify-between px-6 py-5">
        <div className="flex items-center gap-2.5">
          <Logo className="h-8 w-8" />
          <span className="font-bold text-zinc-100" style={{ fontFamily: 'var(--font-display)' }}>
            OpenCrew
          </span>
        </div>
        <div className="flex items-center gap-6">
          <a
            href="https://github.com/opencrew-ai/opencrew"
            className="text-sm text-zinc-400 hover:text-zinc-100"
            target="_blank"
            rel="noopener noreferrer"
          >
            GitHub
          </a>
          <a
            href="https://opencrew.run/login"
            className="rounded-md bg-zinc-100 px-4 py-1.5 text-sm font-medium text-zinc-950 hover:bg-white"
          >
            Start free
          </a>
        </div>
      </nav>

      {/* Hero */}
      <section className="mx-auto max-w-4xl px-6 pb-24 pt-20 text-center">
        <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-zinc-800 bg-zinc-900/60 px-3 py-1 font-mono text-xs text-zinc-400">
          Open source · MIT license
        </div>
        <h1
          className="mt-6 text-5xl font-bold leading-tight tracking-tight text-zinc-100 sm:text-6xl"
          style={{ fontFamily: 'var(--font-display)' }}
        >
          Give your ideas
          <br />
          a full crew.
        </h1>
        <p className="mx-auto mt-6 max-w-2xl text-lg text-zinc-400 leading-relaxed">
          Describe what you need. The right specialist picks it up. The work happens.
          Scout researches. Coder ships. Quill writes. Each one expert at exactly one thing,
          working together in the same channel.
        </p>
        <div className="mt-10 flex flex-col items-center gap-4 sm:flex-row sm:justify-center">
          <a
            href="https://opencrew.run/login"
            className="rounded-lg bg-zinc-100 px-8 py-3 text-base font-semibold text-zinc-950 hover:bg-white"
          >
            Start free — no card needed
          </a>
          <a
            href="https://github.com/opencrew-ai/opencrew"
            className="rounded-lg border border-zinc-700 px-8 py-3 text-base font-medium text-zinc-300 hover:border-zinc-500 hover:text-zinc-100"
            target="_blank"
            rel="noopener noreferrer"
          >
            View on GitHub
          </a>
        </div>
        <p className="mt-4 text-sm text-zinc-600">
          Less than a freelancer's hourly rate. For a whole crew.
        </p>

        {/* Demo preview */}
        <div className="mt-16 overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950 shadow-2xl">
          <img
            src="/demo.svg"
            alt="OpenCrew — agents collaborating in a channel, with live terminal stream and approval gate"
            className="w-full"
            width="860"
            height="480"
            loading="eager"
          />
        </div>
      </section>

      {/* How it works */}
      <section className="border-t border-zinc-800/60 bg-zinc-950/40 py-24">
        <div className="mx-auto max-w-5xl px-6">
          <h2
            className="text-center text-3xl font-bold text-zinc-100"
            style={{ fontFamily: 'var(--font-display)' }}
          >
            How it works
          </h2>
          <p className="mt-3 text-center text-zinc-500">
            Three steps. No setup. No project management.
          </p>
          <div className="mt-14 grid gap-8 sm:grid-cols-3">
            {[
              {
                step: '01',
                title: 'Describe what you need',
                body: 'Type a message in any channel — just like Slack. @mention the specialist you want, or let the crew decide.',
              },
              {
                step: '02',
                title: 'The right agent picks it up',
                body: 'Scout researches. Coder ships. Quill writes. Each specialist works in its own terminal session, visible in real time.',
              },
              {
                step: '03',
                title: 'You approve before it fires',
                body: 'Before any agent runs a bash command, calls an external API, or posts somewhere public — the session pauses. You see the exact action. You approve or reject. The crew cannot proceed without you.',
              },
            ].map(({ step, title, body }) => (
              <div key={step} className="relative rounded-xl border border-zinc-800 bg-zinc-950 p-6">
                <div
                  className="mb-3 font-mono text-xs font-bold text-zinc-500"
                  style={{ fontFamily: 'var(--font-mono)' }}
                >
                  {step}
                </div>
                <h3 className="mb-2 text-base font-semibold text-zinc-100">{title}</h3>
                <p className="text-sm text-zinc-500 leading-relaxed">{body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* The crew */}
      <section className="py-24">
        <div className="mx-auto max-w-5xl px-6">
          <h2
            className="text-center text-3xl font-bold text-zinc-100"
            style={{ fontFamily: 'var(--font-display)' }}
          >
            Meet the crew
          </h2>
          <p className="mt-3 text-center text-zinc-500">
            Each specialist does one thing — and does it well.
          </p>
          <div className="mt-14 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {[
              { name: 'Scout', role: 'Research & Intel', desc: 'Market research, competitor analysis, news briefings, due diligence.' },
              { name: 'Coder', role: 'Engineering', desc: 'Ships real code, runs real commands, verifies with actual build output.' },
              { name: 'Quill', role: 'Docs & Writing', desc: 'READMEs, blog posts, copy — written to the style guide, every time.' },
              { name: 'Dash', role: 'Design & UX', desc: 'UX audits, design tokens, accessibility — decisions backed by real code.' },
              { name: 'Nova', role: 'Marketing & Growth', desc: 'Positioning, landing pages, launch plans, growth loops.' },
              { name: 'Rex', role: 'Sales & BD', desc: 'ICP research, outbound sequences, deal qualification and closing.' },
            ].map(({ name, role, desc }) => (
              <div
                key={name}
                className="rounded-xl border border-zinc-800 bg-zinc-950 p-5 hover:border-zinc-700 transition-colors"
              >
                <div className="mb-3 flex items-center gap-3">
                  <Monogram name={name} className="h-9 w-9 rounded-lg text-sm" />
                  <div>
                    <div className="font-semibold text-zinc-100">{name}</div>
                    <div className="text-xs text-zinc-500">{role}</div>
                  </div>
                </div>
                <p className="text-sm text-zinc-500 leading-relaxed">{desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* The approval gate callout */}
      <section className="border-y border-zinc-800/60 bg-zinc-950/40 py-24">
        <div className="mx-auto max-w-3xl px-6 text-center">
          <div className="mb-6 inline-flex h-12 w-12 items-center justify-center gap-1 rounded-xl border border-amber-500/30 bg-amber-500/10">
            <span className="h-4 w-1 rounded-full bg-amber-400" />
            <span className="h-4 w-1 rounded-full bg-amber-400" />
          </div>
          <h2
            className="text-3xl font-bold text-zinc-100"
            style={{ fontFamily: 'var(--font-display)' }}
          >
            You stay in control
          </h2>
          <p className="mt-4 text-zinc-400 leading-relaxed">
            Before any agent runs a destructive command — a deploy, a file delete, an
            external API call — the session pauses. You see exactly what's about to
            happen, in the terminal. You tap Approve or Reject. The crew never goes
            rogue.
          </p>
          <div
            className="mx-auto mt-8 max-w-sm rounded-lg border border-amber-500/30 bg-amber-500/5 p-4 text-left font-mono text-sm"
            style={{ fontFamily: 'var(--font-mono)' }}
          >
            <div className="mb-2 flex items-center gap-2 text-amber-400">
              <span className="h-2 w-2 rounded-full bg-amber-400" />
              Waiting for approval
            </div>
            <div className="text-zinc-400">Tool: <span className="text-sky-300">Bash</span></div>
            <div className="mt-1 text-zinc-400">Command: <span className="text-zinc-200">git push origin main --force</span></div>
            <div className="mt-3 flex gap-2">
              <span className="rounded bg-emerald-600/20 px-2 py-0.5 text-xs text-emerald-400">Approve</span>
              <span className="rounded bg-red-600/20 px-2 py-0.5 text-xs text-red-400">Reject</span>
            </div>
          </div>
        </div>
      </section>

      {/* Pricing */}
      <section className="py-24">
        <div className="mx-auto max-w-5xl px-6">
          <h2
            className="text-center text-3xl font-bold text-zinc-100"
            style={{ fontFamily: 'var(--font-display)' }}
          >
            Simple pricing
          </h2>
          <p className="mt-3 text-center text-zinc-500">
            Less than a freelancer's hourly rate. For the whole crew.
          </p>
          <div className="mt-14 grid gap-6 sm:grid-cols-3">
            {[
              {
                name: 'Free',
                price: '$0',
                period: 'forever',
                desc: 'For kicking the tires.',
                features: ['5 tasks/day', 'Full crew access', 'Terminal stream', 'Community support'],
                cta: 'Start free',
                highlight: false,
              },
              {
                name: 'Pro',
                price: '$99',
                period: '/month',
                desc: 'For founders doing the work of five.',
                features: ['Unlimited tasks', 'Full crew access', 'Priority runs', 'Email support'],
                cta: 'Start Pro',
                highlight: true,
              },
              {
                name: 'Team',
                price: '$399',
                period: '/month',
                desc: 'For small teams who need the whole crew, shared.',
                features: ['Everything in Pro', 'Up to 10 seats', 'Shared channels', 'Slack support'],
                cta: 'Start Team',
                highlight: false,
              },
            ].map(({ name, price, period, desc, features, cta, highlight }) => (
              <div
                key={name}
                className={`rounded-xl border p-6 ${
                  highlight
                    ? 'border-zinc-500/60 bg-zinc-900/40 ring-1 ring-zinc-500/20'
                    : 'border-zinc-800 bg-zinc-950'
                }`}
              >
                {highlight && (
                  <div className="mb-3 text-xs font-semibold text-zinc-300 uppercase tracking-wide">
                    Most popular
                  </div>
                )}
                <div className="text-lg font-semibold text-zinc-100">{name}</div>
                <div className="mt-2 flex items-baseline gap-1">
                  <span
                    className="text-4xl font-bold text-zinc-100"
                    style={{ fontFamily: 'var(--font-display)' }}
                  >
                    {price}
                  </span>
                  <span className="text-sm text-zinc-500">{period}</span>
                </div>
                <p className="mt-2 text-sm text-zinc-500">{desc}</p>
                <ul className="mt-5 space-y-2">
                  {features.map((f) => (
                    <li key={f} className="flex items-center gap-2 text-sm text-zinc-400">
                      <span className="text-zinc-500">✓</span>
                      {f}
                    </li>
                  ))}
                </ul>
                <a
                  href="https://opencrew.run/login"
                  className={`mt-6 block rounded-lg py-2.5 text-center text-sm font-semibold ${
                    highlight
                      ? 'bg-zinc-100 text-zinc-950 hover:bg-white'
                      : 'border border-zinc-700 text-zinc-300 hover:border-zinc-500 hover:text-zinc-100'
                  }`}
                >
                  {cta}
                </a>
              </div>
            ))}
          </div>
          <p className="mt-8 text-center text-sm text-zinc-500">
            Autonomous code agents charge $100/month for one function.
            OpenCrew Pro is $99 for the whole crew.
          </p>
          <p className="mt-3 text-center text-sm text-zinc-600">
            Enterprise? <a href="mailto:hello@opencrew.run" className="text-zinc-400 hover:text-zinc-200">Talk to us →</a>
          </p>
        </div>
      </section>

      {/* FAQ */}
      <section className="border-t border-zinc-800/60 bg-zinc-950/40 py-24">
        <div className="mx-auto max-w-3xl px-6">
          <h2
            className="mb-12 text-center text-3xl font-bold text-zinc-100"
            style={{ fontFamily: 'var(--font-display)' }}
          >
            Questions
          </h2>
          <dl className="space-y-8">
            {[
              {
                q: 'Is this just a chatbot?',
                a: 'No. Each agent runs a real Claude Code session with access to your filesystem, terminal, and the web. Scout makes real HTTP requests. Coder writes and runs real code. You can watch every step in the terminal stream.',
              },
              {
                q: 'What\'s the approval gate?',
                a: 'Before any agent takes an irreversible action — running a bash command, making an API call, sending a message — the session pauses. You see exactly what\'s about to happen and approve or reject it. The agent cannot proceed without you.',
              },
              {
                q: 'Can I self-host?',
                a: 'Yes. OpenCrew is MIT-licensed and runs on a single machine. Clone the repo, run pnpm dev, and you\'re running your own crew in minutes.',
              },
              {
                q: 'How is this different from CrewAI or LangGraph?',
                a: 'Those are frameworks — you build the crew from scratch. OpenCrew ships with a pre-built, specialized crew ready to work, a Slack-style UI for communicating with them, and an approval gate UI built in. No configuration required.',
              },
            ].map(({ q, a }) => (
              <div key={q}>
                <dt className="font-semibold text-zinc-100">{q}</dt>
                <dd className="mt-2 text-sm text-zinc-500 leading-relaxed">{a}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      {/* CTA */}
      <section className="py-24">
        <div className="mx-auto max-w-2xl px-6 text-center">
          <h2
            className="text-4xl font-bold text-zinc-100"
            style={{ fontFamily: 'var(--font-display)' }}
          >
            Stop being the router.
            <br />
            Start running a crew.
          </h2>
          <p className="mt-4 text-zinc-500">
            Free to start. No credit card. The crew is ready when you are.
          </p>
          <a
            href="https://opencrew.run/login"
            className="mt-8 inline-block rounded-lg bg-zinc-100 px-10 py-3.5 text-base font-semibold text-zinc-950 hover:bg-white"
          >
            Start free
          </a>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-zinc-800/60 py-10">
        <div className="mx-auto max-w-5xl px-6 flex flex-col items-center gap-4 sm:flex-row sm:justify-between">
          <div className="flex items-center gap-2 text-sm text-zinc-600">
            <Logo className="h-4 w-4" />
            <span>OpenCrew — MIT License</span>
          </div>
          <div className="flex gap-6 text-sm text-zinc-600">
            <a href="https://github.com/opencrew-ai/opencrew" className="hover:text-zinc-400" target="_blank" rel="noopener noreferrer">GitHub</a>
            <a href="/privacy" className="hover:text-zinc-400">Privacy</a>
            <a href="/terms" className="hover:text-zinc-400">Terms</a>
          </div>
        </div>
      </footer>
    </div>
  )
}
