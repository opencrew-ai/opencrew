#!/usr/bin/env bash
# OpenCrew one-line installer
# Usage: curl -fsSL https://opencrew.run/install | bash
#
# What this does:
#   1. Checks/installs Node 20+
#   2. Checks/installs pnpm
#   3. Checks/installs Claude Code CLI
#   4. Clones the repo (or updates if already cloned)
#   5. Installs dependencies
#   6. Starts pnpm dev
#
# Environment variables:
#   OPENCREW_DIR   — where to clone (default: ~/opencrew)
#   OPENCREW_REPO  — git URL to clone from (default: https://github.com/opencrew-ai/opencrew)
#   OPENCREW_SKIP_DEV — set to 1 to skip launching pnpm dev

set -euo pipefail

OPENCREW_DIR="${OPENCREW_DIR:-$HOME/opencrew}"
OPENCREW_REPO="${OPENCREW_REPO:-https://github.com/opencrew-ai/opencrew}"
OPENCREW_SKIP_DEV="${OPENCREW_SKIP_DEV:-0}"

# ── colours ──────────────────────────────────────────────────────────────────
if [ -t 1 ]; then
  BOLD="\033[1m"; GREEN="\033[32m"; YELLOW="\033[33m"; RED="\033[31m"; RESET="\033[0m"
else
  BOLD=""; GREEN=""; YELLOW=""; RED=""; RESET=""
fi

info()    { echo -e "${GREEN}▶${RESET} $*"; }
warn()    { echo -e "${YELLOW}⚠${RESET}  $*"; }
success() { echo -e "${GREEN}✓${RESET} $*"; }
fatal()   { echo -e "${RED}✗${RESET} $*" >&2; exit 1; }
header()  { echo -e "\n${BOLD}$*${RESET}"; }

# ── helpers ───────────────────────────────────────────────────────────────────
need_cmd() { command -v "$1" &>/dev/null || fatal "Required command not found: $1. Please install it and re-run."; }

node_version_ok() {
  command -v node &>/dev/null || return 1
  local v; v=$(node -e "process.exit(process.version.slice(1).split('.')[0] < 20 ? 1 : 0)" 2>/dev/null && echo ok || echo fail)
  [ "$v" = "ok" ]
}

# ── banner ────────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}  ⚓ OpenCrew installer${RESET}"
echo "  https://github.com/opencrew-ai/opencrew"
echo ""

# ── 1. Node 20+ ───────────────────────────────────────────────────────────────
header "1/5  Node.js 20+"
if node_version_ok; then
  success "Node $(node --version) already installed"
else
  info "Node 20+ not found — installing via nvm"
  if ! command -v nvm &>/dev/null; then
    info "Installing nvm first…"
    curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
    # Source nvm for this script session
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
  success "pnpm $(pnpm --version) already installed"
else
  info "Installing pnpm via corepack…"
  corepack enable
  corepack prepare pnpm@latest --activate
  success "pnpm $(pnpm --version) installed"
fi

# ── 3. Claude Code CLI ────────────────────────────────────────────────────────
header "3/5  Claude Code"
if command -v claude &>/dev/null; then
  success "Claude Code already installed ($(claude --version 2>/dev/null | head -1))"
else
  info "Installing Claude Code CLI…"
  npm install -g @anthropic-ai/claude-code
  success "Claude Code installed"
fi

# Check auth — the CLI exits non-zero and prints to stderr when not logged in.
if claude --version &>/dev/null; then
  # Attempt a lightweight auth check by listing models; if ANTHROPIC_API_KEY
  # is set we skip the interactive login entirely.
  if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
    success "ANTHROPIC_API_KEY is set — skipping interactive Claude login"
  else
    echo ""
    warn "You need to log in to Claude Code (one-time)."
    warn "Run:  claude login"
    warn "Then re-run this script, or cd into $OPENCREW_DIR and run: pnpm dev"
    echo ""
    # Don't exit — let the rest of the setup continue so it's ready to go.
  fi
fi

# ── 4. Clone / update repo ───────────────────────────────────────────────────
header "4/5  Repository"
if [ -d "$OPENCREW_DIR/.git" ]; then
  info "Repo already cloned at $OPENCREW_DIR — pulling latest…"
  git -C "$OPENCREW_DIR" pull --ff-only
  success "Up to date"
else
  info "Cloning $OPENCREW_REPO → $OPENCREW_DIR"
  git clone "$OPENCREW_REPO" "$OPENCREW_DIR"
  success "Cloned"
fi

# ── 5. Dependencies ───────────────────────────────────────────────────────────
header "5/5  Dependencies"
info "Running pnpm install…"
pnpm --dir "$OPENCREW_DIR" install
success "Dependencies installed"

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}${GREEN}  ✓ OpenCrew is ready!${RESET}"
echo ""
echo "  Admin login:"
echo "    Email:    admin@opencrew.local"
echo "    Password: opencrew"
echo ""

if [ "$OPENCREW_SKIP_DEV" = "1" ]; then
  echo "  Start with:"
  echo "    cd $OPENCREW_DIR && pnpm dev"
  echo ""
else
  echo "  Starting OpenCrew (Ctrl-C to stop)…"
  echo "  → http://localhost:5173"
  echo ""
  cd "$OPENCREW_DIR" && pnpm dev
fi
