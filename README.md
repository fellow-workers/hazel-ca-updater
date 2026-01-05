# hazel-server (Vercel)

This repo deploys a Hazel update server (for Electron auto-updates) to Vercel.

## Environment variables

Set either:

- `REPO=owner/repo`

or:

- `ACCOUNT=owner`
- `REPOSITORY=repo`

Optional:

- `TOKEN` (or `GITHUB_TOKEN`) for private repos / higher rate limits
- `URL` only needed if you want to override the base URL (on Vercel, `VERCEL_URL` is used automatically)

## Local run

```zsh
npm install
npm run dev
```

Open `http://localhost:4000/`.

## Deploy to Vercel

1. Push this repo to GitHub.
2. In Vercel: **Add New → Project → Import**.
3. Set the environment variables above.
4. Deploy.

All routes are rewritten to the serverless function via `vercel.json`.
