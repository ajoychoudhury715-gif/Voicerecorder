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
const TRANSCRIPTION_MODEL = 'whisper-large-v3';
const SUMMARY_MODEL = 'llama-3.1-8b-instant';
const MAX_AUDIO_BYTES = 100 * 1024 * 1024;
const MAX_SPEECH_CONTEXT_CHARS = 500;

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

function normalizeSpeechContext(value) {
  if (typeof value !== 'string') {
    return '';
  }

  return value.replace(/\s+/g, ' ').trim().slice(0, MAX_SPEECH_CONTEXT_CHARS);
}

function buildTranscriptionPrompt(language, speechContext) {
  const instructions = [
    'Transcribe the audio faithfully.',
    'Use natural punctuation and paragraph breaks, but do not summarize, translate, or paraphrase.',
    'Preserve names, product terms, acronyms, numbers, dates, and URLs exactly when they are clear.',
  ];

  if (language === 'hi') {
    instructions.push('The spoken language is Hindi.');
  } else if (language === 'en') {
    instructions.push('The spoken language is English.');
  } else {
    instructions.push('The speaker may switch naturally between Hindi and English in the same sentence.');
  }

  if (speechContext) {
    instructions.push(
      `If these names or terms are spoken, prefer these spellings exactly: ${speechContext}`
    );
  }

  return instructions.join(' ');
}

async function transcribeAudio(audioFile, language, speechContext) {
  const formData = new FormData();
  formData.append('file', audioFile, audioFile.name || 'recording.webm');
  formData.append('model', TRANSCRIPTION_MODEL);
  formData.append('response_format', 'verbose_json');
  formData.append('temperature', '0');

  if (language === 'hi' || language === 'en') {
    formData.append('language', language);
  }

  const prompt = buildTranscriptionPrompt(language, speechContext);
  if (prompt) {
    formData.append('prompt', prompt);
  }

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

  const data = await response.json();
  return data?.text?.trim() || '';
}

function buildSummaryPrompt(language, speechContext) {
  const languageInstruction =
    language === 'hi'
      ? 'Write the full summary in Hindi.'
      : language === 'en'
        ? 'Write the full summary in English.'
        : 'Write the summary in the same language style as the transcript. If the speaker mixed Hindi and English, keep the summary naturally bilingual instead of forcing only one language.';

  const glossaryInstruction = speechContext
    ? `Preserve the exact spelling of these names or terms whenever they appear in the transcript or are clearly implied: ${speechContext}`
    : '';

  return [SUMMARY_PROMPT, languageInstruction, glossaryInstruction].filter(Boolean).join('\n\n');
}

async function summarizeTranscript(transcript, language, speechContext) {
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
        { role: 'system', content: buildSummaryPrompt(language, speechContext) },
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
    const language = formData.get('language');
    const speechContext = normalizeSpeechContext(formData.get('speechContext'));
    const normalizedLanguage =
      language === 'hi' || language === 'en' ? language : 'auto';

    if (!(audioFile instanceof File)) {
      return Response.json({ error: 'No audio file provided.' }, { status: 400 });
    }

    if (audioFile.size === 0) {
      return Response.json({ error: 'The recorded audio file is empty.' }, { status: 400 });
    }

    if (audioFile.size > MAX_AUDIO_BYTES) {
      return Response.json(
        { error: 'The audio file is larger than the current 100 MB upload limit.' },
        { status: 400 }
      );
    }

    const transcript = await transcribeAudio(audioFile, normalizedLanguage, speechContext);

    if (!transcript) {
      return Response.json({ error: 'No transcript generated.' }, { status: 400 });
    }

    const summary = await summarizeTranscript(transcript, normalizedLanguage, speechContext);

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
