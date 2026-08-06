#!/bin/zsh
# Frong Ledger surge mirror sync.
# GitHub Actions is the data writer (refresh.yml, every 10 min). This job just
# pulls the latest committed data and mirrors the site to frong-ledger.surge.sh
# so both URLs stay fresh. Retire with:
#   launchctl unload ~/Library/LaunchAgents/com.pondkeeper.frong-ledger.plist
set -u
export TZ=UTC
export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:/usr/bin:/bin:/usr/sbin"
cd "$HOME/frong-ledger" || exit 1
source "$HOME/.config/api-keys.env"
export FRONG_GH_TOKEN SURGE_LOGIN SURGE_TOKEN

echo "=== sync $(date -u +%FT%H:%M:%SZ) ===" >> .local_cron.log
before=$(git rev-parse HEAD)
git pull --rebase --quiet 2>> .local_cron.log || { git rebase --abort 2>/dev/null; echo "pull failed" >> .local_cron.log; exit 1; }
after=$(git rev-parse HEAD)
if [ "$before" = "$after" ] && [ -d .surge_build ]; then
  echo "no new data, skip deploy" >> .local_cron.log
  exit 0
fi
rm -rf .surge_build
cp -R docs .surge_build
sed -i '' 's|https://pondkeeper.github.io/frong-ledger/assets/og.png|https://frong-ledger.surge.sh/assets/og.png|' .surge_build/index.html
npx --yes surge ./.surge_build frong-ledger.surge.sh >> .local_cron.log 2>&1 \
  && echo "surge mirror ok" >> .local_cron.log \
  || echo "surge mirror FAILED" >> .local_cron.log
