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

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

async function extractErrorMessage(response) {
  const contentType = response.headers.get('content-type') || '';
  const fallbackMessage = `OpenAI request failed with status ${response.status}`;

  if (contentType.includes('application/json')) {
    const data = await response.json().catch(() => null);
    return data?.error?.message || data?.message || fallbackMessage;
  }

  const text = await response.text().catch(() => '');
  return text || fallbackMessage;
}

async function transcribeAudio(audioFile) {
  const formData = new FormData();
  formData.append('file', audioFile, audioFile.name || 'recording.webm');
  formData.append('model', 'whisper-1');
  formData.append('response_format', 'text');

  const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: formData,
  });

  if (!response.ok) {
    throw new Error(await extractErrorMessage(response));
  }

  return (await response.text()).trim();
}

async function summarizeTranscript(transcript) {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4o',
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
  if (!process.env.OPENAI_API_KEY) {
    return Response.json(
      { error: 'OPENAI_API_KEY is not configured on the server.' },
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

    const transcript = await transcribeAudio(audioFile);

    if (!transcript) {
      return Response.json({ error: 'No transcript generated.' }, { status: 400 });
    }

    const summary = await summarizeTranscript(transcript);

    return Response.json({ transcript, summary });
  } catch (error) {
    console.error('Error processing audio:', error);

    return Response.json(
      { error: error instanceof Error ? error.message : 'Unknown error processing audio.' },
      { status: 500 }
    );
  }
}
