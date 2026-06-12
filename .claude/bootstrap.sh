#!/usr/bin/env bash
# Bootstrap Claude Code configuration for njangi-on-chain
#
# This script sets up project-specific Claude Code configuration including:
# - Custom slash commands (skills)
# - Development hooks
# - Project settings
#
# Idempotent: safe to re-run. Backs up existing configuration before updating.
#
# Usage:
#   bash .claude/bootstrap.sh

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLAUDE_CONFIG_DIR="${PROJECT_ROOT}/.claude"
HOME_CLAUDE_DIR="${HOME}/.claude"
BACKUP_DIR="${HOME_CLAUDE_DIR}/backups/njangi-$(date +%Y%m%dT%H%M%S)"

echo "🚀 Bootstrapping Claude Code for njangi-on-chain"
echo "   Project: ${PROJECT_ROOT}"
echo ""

# Ensure home .claude directory exists
mkdir -p "${HOME_CLAUDE_DIR}" "${HOME_CLAUDE_DIR}/plugins"

backup() {
  local path="$1"
  if [[ -e "$path" || -L "$path" ]]; then
    mkdir -p "${BACKUP_DIR}"
    mv "$path" "${BACKUP_DIR}/"
    echo "   ✓ backed up $(basename "$path") to ${BACKUP_DIR}/"
  fi
}

# --- Skills: symlink project-specific skills into ~/.claude/skills ---
echo "📚 Setting up project skills..."

# Remove old njangi-specific symlinks first
if [[ -d "${HOME_CLAUDE_DIR}/skills" ]]; then
  for skill in test-contracts build-deploy check-yield verify-circle start-zklogin check-env deploy-testnet; do
    skill_path="${HOME_CLAUDE_DIR}/skills/${skill}"
    if [[ -L "$skill_path" ]]; then
      target="$(readlink "$skill_path" || true)"
      if [[ "$target" == *"njangi-on-chain"* ]]; then
        rm "$skill_path"
        echo "   ✓ removed old symlink: $skill"
      fi
    fi
  done
fi

# Create skills directory if needed
mkdir -p "${HOME_CLAUDE_DIR}/skills"

# Symlink each skill
for skill_dir in "${CLAUDE_CONFIG_DIR}/skills"/*; do
  if [[ -d "$skill_dir" ]]; then
    skill_name="$(basename "$skill_dir")"
    target_path="${HOME_CLAUDE_DIR}/skills/${skill_name}"

    if [[ -L "$target_path" && "$(readlink "$target_path")" == "$skill_dir" ]]; then
      echo "   ✓ ${skill_name} already linked"
    else
      backup "$target_path"
      ln -s "$skill_dir" "$target_path"
      echo "   ✓ linked ${skill_name}"
    fi
  fi
done

# --- Settings: create project-local settings reference ---
echo ""
echo "⚙️  Setting up configuration..."

SETTINGS_SRC="${CLAUDE_CONFIG_DIR}/settings.json"
SETTINGS_DST="${HOME_CLAUDE_DIR}/settings.json"

if [[ ! -f "$SETTINGS_SRC" ]]; then
  echo "   ⚠️  Warning: ${SETTINGS_SRC} not found"
else
  # Check if we should merge or replace
  if [[ -f "$SETTINGS_DST" ]]; then
    echo "   ℹ️  Existing settings.json found"
    echo "   You can merge project settings manually or replace:"
    echo "      cp ${SETTINGS_SRC} ${SETTINGS_DST}"
  else
    cp "$SETTINGS_SRC" "$SETTINGS_DST"
    echo "   ✓ copied settings.json"
  fi
fi

# --- Project-local settings ---
if [[ ! -f "${CLAUDE_CONFIG_DIR}/settings.local.json" ]]; then
  cat > "${CLAUDE_CONFIG_DIR}/settings.local.json" <<'EOF'
{
  "permissions": {
    "allow": [
      "Bash(ls:*)",
      "Bash(rg:*)",
      "Bash(grep:*)",
      "Bash(cd /Volumes/Developing/njangi-on-chain*)",
      "Read(/Volumes/Developing/njangi-on-chain/**)"
    ],
    "deny": []
  }
}
EOF
  echo "   ✓ created settings.local.json"
fi

# --- Information ---
echo ""
echo "✅ Bootstrap complete!"
echo ""
echo "📋 Available skills:"
echo "   /test-contracts    - Run Move contract tests"
echo "   /build-deploy      - Build and deploy contracts"
echo "   /check-yield       - Verify yield integration"
echo "   /verify-circle     - Check circle state on-chain"
echo "   /start-zklogin     - Start zkLogin services"
echo "   /check-env         - Validate environment"
echo "   /deploy-testnet    - Full testnet deployment"
echo ""
echo "🔧 Next steps:"
echo "   1. Restart Claude Code to load new skills"
echo "   2. Run /check-env to verify configuration"
echo "   3. Run /start-zklogin to start development services"
echo "   4. See CLAUDE.md for detailed workflow guide"
echo ""

if [[ -d "$BACKUP_DIR" ]]; then
  echo "💾 Backups saved to: ${BACKUP_DIR}"
  echo ""
fi

echo "Happy coding! 🎉"
