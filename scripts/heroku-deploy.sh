#!/bin/bash

# Heroku Deployment Helper Script
# Deploys both frontend and backend to Heroku

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
HEROKU_APP="njangi-on-chain"
MAIN_BRANCH="main"

# Functions
print_header() {
    echo -e "${BLUE}════════════════════════════════════════${NC}"
    echo -e "${BLUE}$1${NC}"
    echo -e "${BLUE}════════════════════════════════════════${NC}"
}

print_success() {
    echo -e "${GREEN}✅ $1${NC}"
}

print_warning() {
    echo -e "${YELLOW}⚠️  $1${NC}"
}

print_error() {
    echo -e "${RED}❌ $1${NC}"
}

# Check if on main branch
print_header "Checking Git Status"
current_branch=$(git rev-parse --abbrev-ref HEAD)
if [ "$current_branch" != "$MAIN_BRANCH" ]; then
    print_error "Not on $MAIN_BRANCH branch! Currently on: $current_branch"
    echo "Switch to main branch first: git checkout main"
    exit 1
fi
print_success "On $MAIN_BRANCH branch"

# Check for uncommitted changes
if [ -n "$(git status --porcelain)" ]; then
    print_warning "You have uncommitted changes:"
    git status --short
    read -p "Continue anyway? (y/n) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        print_error "Deploy cancelled"
        exit 1
    fi
fi

# Check Heroku CLI
print_header "Checking Heroku Setup"
if ! command -v heroku &> /dev/null; then
    print_error "Heroku CLI not installed. Install it from https://devcenter.heroku.com/articles/heroku-cli"
    exit 1
fi
print_success "Heroku CLI found"

# Check if logged in
if ! heroku auth:whoami > /dev/null 2>&1; then
    print_error "Not logged into Heroku. Run: heroku login"
    exit 1
fi
print_success "Logged into Heroku"

# Check app exists
if ! heroku apps:info -a "$HEROKU_APP" > /dev/null 2>&1; then
    print_error "Heroku app '$HEROKU_APP' not found"
    exit 1
fi
print_success "Heroku app '$HEROKU_APP' found"

# Show what we're deploying
print_header "Deployment Plan"
echo "App: $HEROKU_APP"
echo "Branch: $MAIN_BRANCH"
echo "Processes:"
echo "  - web: Next.js frontend (port 3000)"
echo "  - bot: WhatsApp backend (port 3001)"

# Confirm deployment
read -p "Proceed with deployment? (y/n) " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    print_error "Deploy cancelled"
    exit 1
fi

# Deploy
print_header "Deploying to Heroku"
echo "Pushing code to Heroku..."
git push heroku "$MAIN_BRANCH"

# Check deployment status
print_header "Checking Deployment Status"
echo "Waiting for processes to start..."
sleep 5

# Show running processes
heroku ps -a "$HEROKU_APP"

# Show latest logs
print_header "Recent Logs"
echo "Web process:"
heroku logs -a "$HEROKU_APP" --dyno=web --num=10

echo ""
echo "Bot process:"
heroku logs -a "$HEROKU_APP" --dyno=bot --num=10

# Verify deployment
print_header "Verification"
echo "Frontend URL: https://${HEROKU_APP}.herokuapp.com"
echo ""
print_success "Deployment complete!"
echo ""
echo "Next steps:"
echo "1. Visit https://${HEROKU_APP}.herokuapp.com/ to test frontend"
echo "2. Monitor logs: heroku logs -a $HEROKU_APP --tail"
echo "3. Check processes: heroku ps -a $HEROKU_APP"
echo "4. Test WhatsApp webhook (send message to bot)"

