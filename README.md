# Voice Summary Tool on Vercel

A web-based voice recording and summarization tool using OpenAI's Whisper and GPT-4o, deployed on Vercel with Next.js route handlers.

## Features

- Record audio directly in the browser
- Transcribe speech using OpenAI Whisper
- Generate structured summaries with GPT-4o

## Setup

1. Clone or copy this project.
2. Install dependencies: `npm install`
3. Set your OpenAI API key in `.env`
4. Run locally: `npm run dev`
5. Deploy to Vercel: `vercel`

## Deployment

This project is configured for Vercel deployment with Next.js and a server-side `/api/transcribe` route.
