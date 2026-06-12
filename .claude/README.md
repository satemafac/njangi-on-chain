# Claude Code Configuration

This directory contains Claude Code configuration for the njangi-on-chain project.

## Structure

```
.claude/
├── bootstrap.sh           # Setup script for Claude Code
├── settings.json          # Hooks and configuration
├── settings.local.json    # Project-specific permissions
├── skills/                # Custom slash commands
│   ├── test-contracts/    # /test-contracts - Run Move tests
│   ├── build-deploy/      # /build-deploy - Build & deploy
│   ├── check-yield/       # /check-yield - Verify yield integration
│   ├── verify-circle/     # /verify-circle - Check circle state
│   ├── start-zklogin/     # /start-zklogin - Start auth services
│   ├── check-env/         # /check-env - Validate environment
│   └── deploy-testnet/    # /deploy-testnet - Full deployment
└── plugins/               # Plugin configurations
```

## Quick Start

### Initial Setup

```bash
# Run bootstrap script to install skills and settings
.claude/bootstrap.sh
```

This will:
- Symlink project skills to `~/.claude/skills/`
- Copy settings to `~/.claude/settings.json`
- Create project-local permissions
- Back up any existing configuration

### Using Skills

After restarting Claude Code, use project-specific commands:

```bash
/check-env          # Validate environment setup
/test-contracts     # Run Move contract tests
/build-deploy       # Build and deploy contracts
/check-yield        # Verify yield integration
/start-zklogin      # Start Docker services
```

## Configuration Files

### settings.json

Defines hooks that run during Claude Code operations:

- **SessionStart**: Welcome message with available skills
- **PreToolUse**: Run linter before Edit/Write operations
- **PostToolUse**: Show git diff after changes
- **Stop**: Display git status at end of session

### settings.local.json

Project-specific permissions allowing Claude Code to:
- Run common bash commands (ls, rg, grep)
- Access project files
- Execute git operations

### Skills

Each skill is a directory containing a `SKILL.md` file that defines:
- Task description
- Success criteria
- Implementation steps
- Common issues and solutions

Skills are invoked with `/skill-name` in Claude Code.

## Updating Configuration

### Adding a New Skill

1. Create directory: `.claude/skills/my-skill/`
2. Add `SKILL.md` with task description
3. Run `./bootstrap.sh` to symlink
4. Restart Claude Code

### Modifying Hooks

Edit `.claude/settings.json` and run:

```bash
./bootstrap.sh  # Re-applies settings
```

## Syncing Across Devices

To use this configuration on another machine:

```bash
git clone <repo-url>
cd <repo-name>
.claude/bootstrap.sh
```

The script is idempotent - safe to re-run after pulling updates.

## Hooks Reference

### SessionStart
Runs when starting a new Claude Code session. Currently displays welcome message with available skills.

### PreToolUse (Edit|Write)
Runs before editing files. Executes `npm run lint` to catch issues early.

### PostToolUse (Edit|Write)
Runs after editing files. Shows `git diff --stat` to review changes.

### PostToolUse (Bash git commit)
Runs after git commits. Shows the commit with `git log -1 --oneline`.

### Stop
Runs when stopping Claude Code. Shows `git status` to remind you of uncommitted changes.

## Best Practices

1. **Keep skills focused**: Each skill should do one thing well
2. **Document prerequisites**: List required tools and services
3. **Include success criteria**: Make it clear when task is complete
4. **Add troubleshooting**: Document common issues
5. **Test regularly**: Verify skills work after updates

## Troubleshooting

### Skills Not Available

- Run `./bootstrap.sh` to ensure skills are symlinked
- Restart Claude Code
- Check `~/.claude/skills/` for symlinks

### Hooks Not Running

- Verify `settings.json` is in `~/.claude/`
- Check hook syntax (must be valid JSON)
- Look for errors in Claude Code output
- Use `|| true` at end of commands to prevent blocking

### Permission Errors

- Update `settings.local.json` with required paths
- Ensure scripts have execute permission: `chmod +x`
- Check file paths are absolute, not relative

## Resources

- Claude Code Docs: https://docs.claude.com/en/docs/claude-code
- Project Guide: ../CLAUDE.md
- Main README: ../README.md
