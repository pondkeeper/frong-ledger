#!/bin/zsh
# Frong Ledger local bridge cron — runs while GitHub Actions runners are held.
# Refreshes data, pushes to GitHub (canonical repo), deploys the site to surge.sh.
# Disable (launchctl unload) once GitHub Actions starts running the cron itself.
set -u
export TZ=UTC
export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:/usr/bin:/bin:/usr/sbin"
cd "$HOME/frong-ledger" || exit 1
source "$HOME/.config/api-keys.env"
export FRONG_GH_TOKEN SURGE_LOGIN SURGE_TOKEN

echo "=== run $(date -u +%FT%H:%M:%SZ) ===" >> .local_cron.log

# stay in sync with the remote (GitHub Actions may start committing at any time)
git pull --rebase --quiet 2>> .local_cron.log || { git rebase --abort 2>/dev/null; echo "pull failed, continuing" >> .local_cron.log; }

python3 pipeline/refresh.py >> .local_cron.log 2>&1 || { echo "pipeline FAILED" >> .local_cron.log; exit 1; }

git add docs/data
if ! git diff --cached --quiet; then
  git commit -qm "data refresh (local) $(date -u +%FT%H:%MZ)"
  git push --quiet 2>> .local_cron.log || echo "push failed (will retry next run)" >> .local_cron.log
fi

# surge deploy: patched copy with the bridge og:image URL
rm -rf .surge_build
cp -R docs .surge_build
sed -i '' 's|https://pondkeeper.github.io/frong-ledger/assets/og.png|https://frong-ledger.surge.sh/assets/og.png|' .surge_build/index.html
npx --yes surge ./.surge_build frong-ledger.surge.sh >> .local_cron.log 2>&1 \
  && echo "surge deploy ok" >> .local_cron.log \
  || echo "surge deploy FAILED" >> .local_cron.log
