const SUMMARY_PROMPT = `
You are an expert meeting-notes assistant.
Given a raw spoken transcript, produce a structured summary with exactly three sections:

## Action Items
A numbered list of concrete tasks, owners (if mentioned), and deadlines (if mentioned).
If none are mentioned, write "None identified."

## Key Decisions
A numbered list of decisions that were made or agreed upon during the conversation.
If none are mentioned, write "None identified."

## Concise Overview
Two to four sentences capturing the main topic, context, and outcome of the conversation.

Keep the language professional and concise. Do not add anything outside these three sections.
`.trim();

const API_BASE_URL = 'https://api.groq.com/openai/v1';
const TRANSCRIPTION_MODEL = 'whisper-large-v3-turbo';
const SUMMARY_MODEL = 'llama-3.1-8b-instant';
const MAX_FREE_TIER_AUDIO_BYTES = 25 * 1024 * 1024;

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

async function extractErrorMessage(response) {
  const contentType = response.headers.get('content-type') || '';
  const fallbackMessage = `Groq request failed with status ${response.status}`;

  if (contentType.includes('application/json')) {
    const data = await response.json().catch(() => null);
    return data?.error?.message || data?.message || fallbackMessage;
  }

  const text = await response.text().catch(() => '');
  return text || fallbackMessage;
}

function sanitizeProviderErrorMessage(message) {
  if (!message) {
    return 'Audio processing failed. Please try again.';
  }

  const normalized = message.toLowerCase();

  if (normalized.includes('quota') || normalized.includes('billing')) {
    return 'The speech provider quota has been exceeded. Update your provider key or billing settings and try again.';
  }

  if (normalized.includes('api key') || normalized.includes('authentication') || normalized.includes('unauthorized')) {
    return 'The provider API key is invalid or missing. Check your server environment variables and try again.';
  }

  if (normalized.includes('rate limit') || normalized.includes('too many requests')) {
    return 'Too many requests hit the speech provider. Wait a moment and try again.';
  }

  return message;
}

async function transcribeAudio(audioFile) {
  const formData = new FormData();
  formData.append('file', audioFile, audioFile.name || 'recording.webm');
  formData.append('model', TRANSCRIPTION_MODEL);
  formData.append('response_format', 'text');

  const response = await fetch(`${API_BASE_URL}/audio/transcriptions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
    },
    body: formData,
  });

  if (!response.ok) {
    throw new Error(await extractErrorMessage(response));
  }

  return (await response.text()).trim();
}

async function summarizeTranscript(transcript) {
  const response = await fetch(`${API_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: SUMMARY_MODEL,
      temperature: 0.3,
      messages: [
        { role: 'system', content: SUMMARY_PROMPT },
        { role: 'user', content: `Transcript:\n\n${transcript}` },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(await extractErrorMessage(response));
  }

  const data = await response.json();
  const summary = data?.choices?.[0]?.message?.content?.trim();

  if (!summary) {
    throw new Error('No summary generated.');
  }

  return summary;
}

export async function POST(request) {
  if (!process.env.GROQ_API_KEY) {
    return Response.json(
      { error: 'GROQ_API_KEY is not configured on the server.' },
      { status: 500 }
    );
  }

  try {
    const formData = await request.formData();
    const audioFile = formData.get('audio');

    if (!(audioFile instanceof File)) {
      return Response.json({ error: 'No audio file provided.' }, { status: 400 });
    }

    if (audioFile.size === 0) {
      return Response.json({ error: 'The recorded audio file is empty.' }, { status: 400 });
    }

    if (audioFile.size > MAX_FREE_TIER_AUDIO_BYTES) {
      return Response.json(
        { error: 'The audio file is larger than the Groq free-tier 25 MB upload limit.' },
        { status: 400 }
      );
    }

    const transcript = await transcribeAudio(audioFile);

    if (!transcript) {
      return Response.json({ error: 'No transcript generated.' }, { status: 400 });
    }

    const summary = await summarizeTranscript(transcript);

    return Response.json({ transcript, summary });
  } catch (error) {
    console.error('Error processing audio:', error);

    return Response.json(
      {
        error: sanitizeProviderErrorMessage(
          error instanceof Error ? error.message : 'Unknown error processing audio.'
        ),
      },
      { status: 500 }
    );
  }
}
