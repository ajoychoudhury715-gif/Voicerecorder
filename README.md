# Voice Summary Tool on Vercel

A web-based voice recording and summarization tool using Groq's API, deployed on Vercel with Next.js route handlers.

## Features

- Record audio directly in the browser
- Upload long recordings directly to Vercel Blob without hitting Vercel Function body limits
- Transcribe speech using Groq Whisper Large V3 in accuracy-first mode
- Generate structured summaries with Llama 3.1 8B Instant
- Improve recognition with Hindi/English language modes and optional speech context for names or jargon
- Process multi-hour conversations by recording and transcribing in sequential audio segments
- Expose a remote MCP endpoint so the same pipeline can be used as a ChatGPT app

## Setup

1. Clone or copy this project.
2. Install dependencies: `npm install`
3. Set your Groq API key in `.env` as `GROQ_API_KEY=...`
4. Create a Vercel Blob store and make sure `BLOB_READ_WRITE_TOKEN` is available in your environment.
5. Run locally: `npm run dev`
6. Deploy to Vercel: `vercel`

## Deployment

This project is configured for Vercel deployment with Next.js and a server-side `/api/transcribe` route.

## ChatGPT App Endpoint

The app now exposes a remote MCP server at `/mcp`.

- Local endpoint: `http://localhost:3000/mcp`
- Production endpoint pattern: `https://your-domain.example/mcp`
- Current production endpoint: `https://voicerecorder-omega.vercel.app/mcp`

Available ChatGPT tool:

- `analyze_voice_note`: accepts transcript text or one or more public audio URLs, then returns a transcript, structured summary, action items, key decisions, and a WhatsApp-ready brief.

To connect it inside ChatGPT Developer Mode, add the deployed `/mcp` URL as a custom MCP server.
