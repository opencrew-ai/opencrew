#!/usr/bin/env bash
# OpenCrew one-line installer / launcher
# Usage: curl -fsSL https://opencrew.run/install | bash
#
# First run:  installs Node 20+, pnpm, Claude Code if missing; clones; installs
#             dependencies; starts OpenCrew; opens your browser — signed in.
# Every run after that: pulls updates, skips what is already done, starts in
#             a couple of seconds. Re-running this script IS the start command.
#
# Uninstall: curl -fsSL https://opencrew.run/install | bash -s -- --uninstall
#   Removes the install directory (your workspace data lives inside it).
#   Node, pnpm, and Claude Code are left alone — they're yours.
#
# Environment variables:
#   OPENCREW_DIR       — where to clone (default: ~/opencrew)
#   OPENCREW_REPO      — git URL to clone from (default: https://github.com/opencrew-ai/opencrew)
#   OPENCREW_SKIP_DEV  — set to 1 to set up without starting
#   OPENCREW_NO_UPDATE — set to 1 to skip `git pull` on an existing clone
#   OPENCREW_NO_OPEN   — set to 1 to not open the browser
#   PORT / OPENCREW_WEB_PORT — pin ports; otherwise the first free ones from 3001 / 5173

set -euo pipefail

OPENCREW_DIR="${OPENCREW_DIR:-$HOME/opencrew}"
OPENCREW_REPO="${OPENCREW_REPO:-https://github.com/opencrew-ai/opencrew}"
OPENCREW_SKIP_DEV="${OPENCREW_SKIP_DEV:-0}"
OPENCREW_NO_UPDATE="${OPENCREW_NO_UPDATE:-0}"
OPENCREW_NO_OPEN="${OPENCREW_NO_OPEN:-0}"

# ── uninstall ────────────────────────────────────────────────────────────────
if [ "${1:-}" = "--uninstall" ]; then
  if [ -d "$OPENCREW_DIR" ]; then
    # Stop anything running from that directory first.
    pkill -f "$OPENCREW_DIR" 2>/dev/null || true
    rm -rf "$OPENCREW_DIR"
    echo "Removed $OPENCREW_DIR (workspace data included)."
  else
    echo "Nothing installed at $OPENCREW_DIR."
  fi
  echo "Node, pnpm, and Claude Code were left in place."
  exit 0
fi

# ── ports: the first free ones, so a laptop already running things on 3001 or
#    5173 still gets a working install; pin with PORT / OPENCREW_WEB_PORT. ─────
port_free() { ! (command -v lsof >/dev/null && lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1); }
pick_port() { local p="$1"; while ! port_free "$p"; do p=$((p + 1)); done; echo "$p"; }
API_PORT="${PORT:-$(pick_port 3001)}"
WEB_PORT="${OPENCREW_WEB_PORT:-$(pick_port 5173)}"
APP_URL="http://localhost:${WEB_PORT}"

# ── colours ──────────────────────────────────────────────────────────────────
if [ -t 1 ]; then
  BOLD="\033[1m"; GREEN="\033[32m"; YELLOW="\033[33m"; RED="\033[31m"; DIM="\033[2m"; RESET="\033[0m"
else
  BOLD=""; GREEN=""; YELLOW=""; RED=""; DIM=""; RESET=""
fi

info()    { echo -e "${GREEN}▶${RESET} $*"; }
warn()    { echo -e "${YELLOW}⚠${RESET}  $*"; }
success() { echo -e "${GREEN}✓${RESET} $*"; }
fatal()   { echo -e "${RED}✗${RESET} $*" >&2; exit 1; }
header()  { echo -e "\n${BOLD}$*${RESET}"; }

STARTED_AT=$(date +%s)
elapsed() { echo "$(( $(date +%s) - STARTED_AT ))s"; }

# ── helpers ───────────────────────────────────────────────────────────────────
node_version_ok() {
  command -v node &>/dev/null || return 1
  node -e "process.exit(Number(process.version.slice(1).split('.')[0]) >= 20 ? 0 : 1)" 2>/dev/null
}

claude_logged_in() {
  # `claude auth status` prints JSON with "loggedIn": true|false (2.x).
  command -v claude &>/dev/null || return 1
  [ -n "${ANTHROPIC_API_KEY:-}" ] && return 0
  claude auth status 2>/dev/null | grep -q '"loggedIn": *true'
}

open_browser() {
  if command -v open &>/dev/null; then open "$1" 2>/dev/null
  elif command -v xdg-open &>/dev/null; then xdg-open "$1" 2>/dev/null
  fi
}

# Waits for the app, then opens it — the browser lands on a signed-in HQ.
open_when_ready() {
  local deadline=$(( $(date +%s) + 60 ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if curl -fs "http://localhost:${API_PORT}/api/health" >/dev/null 2>&1 \
       && curl -fs "$APP_URL" >/dev/null 2>&1; then
      open_browser "$APP_URL"
      return 0
    fi
    sleep 0.2
  done
}

# ── banner ────────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}  ⚓ OpenCrew${RESET}  ${DIM}https://github.com/opencrew-ai/opencrew${RESET}"

command -v git >/dev/null || fatal "git is required. Install it (macOS: xcode-select --install) and re-run."
command -v curl >/dev/null || fatal "curl is required."

# ── 1. Node 20+ ───────────────────────────────────────────────────────────────
header "1/5  Node.js 20+"
if node_version_ok; then
  success "Node $(node --version)"
else
  info "Node 20+ not found — installing via nvm"
  if ! command -v nvm &>/dev/null; then
    info "Installing nvm first…"
    curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
    export NVM_DIR="$HOME/.nvm"
    # shellcheck source=/dev/null
    [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
  fi
  nvm install 20 && nvm use 20 && nvm alias default 20
  success "Node $(node --version) installed"
fi

# ── 2. pnpm ───────────────────────────────────────────────────────────────────
header "2/5  pnpm"
if command -v pnpm &>/dev/null; then
  success "pnpm $(pnpm --version)"
else
  info "Installing pnpm via corepack…"
  corepack enable
  corepack prepare pnpm@latest --activate
  success "pnpm $(pnpm --version) installed"
fi

# ── 3. Claude Code CLI ────────────────────────────────────────────────────────
header "3/5  Claude Code"
if command -v claude &>/dev/null; then
  success "Claude Code $(claude --version 2>/dev/null | head -1)"
else
  info "Installing Claude Code CLI…"
  npm install -g @anthropic-ai/claude-code
  success "Claude Code installed"
fi

CLAUDE_READY=1
if claude_logged_in; then
  success "Claude is signed in — agents will use this login"
else
  CLAUDE_READY=0
  warn "Claude Code is not signed in. Agents can't run until you do (one time):"
  warn "    claude login"
fi

# ── 4. Clone / update repo ───────────────────────────────────────────────────
header "4/5  Repository"
if [ -d "$OPENCREW_DIR/.git" ]; then
  if [ "$OPENCREW_NO_UPDATE" = "1" ]; then
    success "Using $OPENCREW_DIR (update skipped)"
  else
    # Braces matter: macOS bash 3.2 reads "$OPENCREW_DIR…" as one variable name.
    info "Updating ${OPENCREW_DIR}…"
    if git -C "$OPENCREW_DIR" pull --ff-only --quiet; then
      success "Up to date"
    else
      warn "Could not fast-forward (local changes?) — starting with what's there"
    fi
  fi
else
  info "Cloning $OPENCREW_REPO → $OPENCREW_DIR"
  git clone --depth 1 "$OPENCREW_REPO" "$OPENCREW_DIR"
  success "Cloned"
fi

# ── 5. Dependencies (only when the lockfile changed) ─────────────────────────
header "5/5  Dependencies"
LOCK_STAMP="$OPENCREW_DIR/node_modules/.opencrew-lockfile"
LOCK_HASH=$(shasum -a 256 "$OPENCREW_DIR/pnpm-lock.yaml" | cut -c1-16)
if [ -f "$LOCK_STAMP" ] && [ "$(cat "$LOCK_STAMP")" = "$LOCK_HASH" ]; then
  success "Already installed"
else
  info "Running pnpm install…"
  pnpm --dir "$OPENCREW_DIR" install --prefer-offline
  echo "$LOCK_HASH" > "$LOCK_STAMP"
  success "Dependencies installed"
fi

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}${GREEN}  ✓ OpenCrew is ready${RESET} ${DIM}($(elapsed))${RESET}"
echo ""
echo "  This machine signs in automatically — no password on localhost."
echo "  Phones and other devices on your network sign in as admin@opencrew.local / opencrew"
echo "  (change it in Settings)."
echo ""

if [ "$OPENCREW_SKIP_DEV" = "1" ]; then
  echo "  Start any time with:"
  echo "    cd $OPENCREW_DIR && pnpm start"
  echo ""
  exit 0
fi

if [ "$CLAUDE_READY" = "0" ]; then
  echo "  Starting anyway — run \`claude login\` in another terminal and the crew comes alive."
  echo ""
fi

echo "  Starting OpenCrew (Ctrl-C to stop) → $APP_URL"
if [ "$API_PORT" != "3001" ] || [ "$WEB_PORT" != "5173" ]; then
  echo "  (ports 3001/5173 were busy, so this install uses API $API_PORT · web $WEB_PORT)"
fi
echo ""
if [ "$OPENCREW_NO_OPEN" != "1" ]; then
  open_when_ready &
fi
cd "$OPENCREW_DIR" && PORT="$API_PORT" OPENCREW_WEB_PORT="$WEB_PORT" OPENCREW_API_PORT="$API_PORT" exec pnpm start
