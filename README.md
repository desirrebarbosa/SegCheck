# SegCheck

A review tool for QA'ing SAM-assisted image segmentation against an original
COCO-format dataset: upload a dataset zip, walk through each detected
instance (bbox + mask), and pass/fail it — then export results as CSV or a
"redo" zip of everything that failed.

Built as a research tool for my current thesis.

## Setup

```bash
npm install
cp .env.example .env.local   # fill in your Supabase project's URL + publishable key
npm run dev
```

Required env vars (`.env.local`, Vite-only so must be prefixed `VITE_`):

| Variable | Description |
|---|---|
| `VITE_SUPABASE_URL` | Your Supabase project URL |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | Supabase anon/publishable key (safe for client use — access is enforced by RLS, not this key) |

## Status

This project is under active development. Early access is available at:
https://seg-check.vercel.app/
