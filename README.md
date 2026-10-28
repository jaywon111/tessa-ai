# Tessa AI

Football predictions tracker with a phone-first web app: sync fixtures, get AI-projected over/under picks with confidence levels, then grade results and track accuracy over time.

## Live app

https://tessa-aii.vercel.app

## What it does

- Predictions view: today's slate with projected totals, confidence (high/medium/low) and reasoning
- Daily Digest: a shareable predictions ticket, one card per match with all its picks grouped (Over 1.5, Under 3.5...), plus Copy Markdown export
- Accuracy view: overall win rate, W-L record and streak, accuracy by line (O/U 1.5 / 2.5 / 3.5), win rate by confidence, and a foldable Recent Results section where picks from the same match are grouped in one card
- Results grading: pending games get graded as matches finish, manually or on the sync schedule

## Run locally

Static site, no build step:

```
npx serve .        # or any static file server
```

Open the printed URL in a browser.

## Deploy

Deployed on Vercel (`vercel --prod`). The serverless function in `api/` powers the sync/predict endpoint.

## Structure

- `index.html` — the whole app (UI + logic)
- `api/index.js` — serverless endpoint for data sync/prediction
- `sw.js`, `manifest.webmanifest`, `icons/` — PWA shell so it installs to a home screen
- `vercel.json` — deploy config

## Notes

Predictions are statistical projections for entertainment and research, not betting advice.
