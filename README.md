# Voice Summary Tool on Vercel

A web-based voice recording and summarization tool using Groq's API, deployed on Vercel with Next.js route handlers.

## Features

- Record audio directly in the browser
- Transcribe speech using Groq Whisper Large V3 Turbo
- Generate structured summaries with Llama 3.1 8B Instant

## Setup

1. Clone or copy this project.
2. Install dependencies: `npm install`
3. Set your Groq API key in `.env` as `GROQ_API_KEY=...`
4. Run locally: `npm run dev`
5. Deploy to Vercel: `vercel`

## Deployment

This project is configured for Vercel deployment with Next.js and a server-side `/api/transcribe` route.
