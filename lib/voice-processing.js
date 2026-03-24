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
const MAX_SINGLE_AUDIO_BYTES = 20 * 1024 * 1024;
const MAX_AUDIO_CHUNKS = 24;
const MAX_SPEECH_CONTEXT_CHARS = 500;
const MAX_SUMMARY_SOURCE_CHARS = 12000;
const MAX_SUMMARY_REDUCTION_PASSES = 3;
const PROVIDER_RETRY_ATTEMPTS = 4;
const RATE_LIMIT_BACKOFF_MS = 6000;

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

export function sanitizeProviderErrorMessage(message) {
  if (!message) {
    return 'Audio processing failed. Please try again.';
  }

  const normalized = message.toLowerCase();

  if (normalized.includes('quota') || normalized.includes('billing')) {
    return 'The speech provider quota has been exceeded. Update your provider key or billing settings and try again.';
  }

  if (
    normalized.includes('api key') ||
    normalized.includes('authentication') ||
    normalized.includes('unauthorized')
  ) {
    return 'The provider API key is invalid or missing. Check your server environment variables and try again.';
  }

  if (
    normalized.includes('rate limit') ||
    normalized.includes('too many requests') ||
    normalized.includes('try again in')
  ) {
    return 'The speech provider rate limit was reached while processing this conversation. Please wait a moment and try again.';
  }

  return message;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function shouldRetryProviderError(message) {
  const normalized = message.toLowerCase();

  return (
    normalized.includes('rate limit') ||
    normalized.includes('too many requests') ||
    normalized.includes('try again in') ||
    normalized.includes('temporarily unavailable') ||
    normalized.includes('timed out') ||
    normalized.includes('timeout')
  );
}

async function withProviderRetries(operation) {
  let lastError = null;

  for (let attempt = 0; attempt < PROVIDER_RETRY_ATTEMPTS; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : 'Unknown provider error.';

      if (!shouldRetryProviderError(message) || attempt === PROVIDER_RETRY_ATTEMPTS - 1) {
        throw error;
      }

      await sleep(RATE_LIMIT_BACKOFF_MS * (attempt + 1));
    }
  }

  throw lastError || new Error('Provider request failed.');
}

export function normalizeSpeechContext(value) {
  if (typeof value !== 'string') {
    return '';
  }

  return value.replace(/\s+/g, ' ').trim().slice(0, MAX_SPEECH_CONTEXT_CHARS);
}

export function normalizeLanguage(value) {
  return value === 'hi' || value === 'en' ? value : 'auto';
}

export function normalizeAudioUrls(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item) => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.startsWith('https://'));
}

export function normalizeTranscriptText(value) {
  if (typeof value !== 'string') {
    return '';
  }

  return value.replace(/\r/g, '').trim();
}

function buildTranscriptionPrompt(language, speechContext, previousTranscriptTail = '') {
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

  if (previousTranscriptTail) {
    instructions.push(
      `This chunk follows the prior transcript tail. Use it only as context and do not repeat it: ${previousTranscriptTail}`
    );
  }

  return instructions.join(' ');
}

async function transcribeAudio({
  audioFile,
  audioUrl,
  language,
  speechContext,
  previousTranscriptTail = '',
}) {
  const formData = new FormData();

  if (audioFile) {
    formData.append('file', audioFile, audioFile.name || 'recording.webm');
  } else if (audioUrl) {
    formData.append('url', audioUrl);
  } else {
    throw new Error('No audio source provided for transcription.');
  }

  formData.append('model', TRANSCRIPTION_MODEL);
  formData.append('response_format', 'verbose_json');
  formData.append('temperature', '0');

  if (language === 'hi' || language === 'en') {
    formData.append('language', language);
  }

  const prompt = buildTranscriptionPrompt(language, speechContext, previousTranscriptTail);
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

export async function transcribeUploadedAudioFile(audioFile, language, speechContext) {
  return withProviderRetries(() =>
    transcribeAudio({
      audioFile,
      language,
      speechContext,
    })
  );
}

export async function transcribeAudioUrls(audioUrls, language, speechContext) {
  const transcriptChunks = [];

  for (let index = 0; index < audioUrls.length; index += 1) {
    const previousTranscriptTail = transcriptChunks.length
      ? transcriptChunks[transcriptChunks.length - 1].slice(-220)
      : '';

    const transcriptChunk = await withProviderRetries(() =>
      transcribeAudio({
        audioUrl: audioUrls[index],
        language,
        speechContext,
        previousTranscriptTail,
      })
    );

    if (transcriptChunk) {
      transcriptChunks.push(transcriptChunk);
    }
  }

  return transcriptChunks.join('\n\n').trim();
}

function splitLongBlock(text, maxChars) {
  const words = text.split(/\s+/).filter(Boolean);
  const chunks = [];
  let current = '';

  words.forEach((word) => {
    const nextValue = current ? `${current} ${word}` : word;

    if (nextValue.length <= maxChars) {
      current = nextValue;
      return;
    }

    if (current) {
      chunks.push(current);
    }

    current = word;
  });

  if (current) {
    chunks.push(current);
  }

  return chunks;
}

function splitTextForSummary(text, maxChars = MAX_SUMMARY_SOURCE_CHARS) {
  const normalizedText = text.replace(/\r/g, '').trim();

  if (!normalizedText) {
    return [];
  }

  const paragraphs = normalizedText
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
  const chunks = [];
  let current = '';

  paragraphs.forEach((paragraph) => {
    if (paragraph.length > maxChars) {
      if (current) {
        chunks.push(current);
        current = '';
      }

      splitLongBlock(paragraph, maxChars).forEach((block) => {
        chunks.push(block);
      });

      return;
    }

    const nextValue = current ? `${current}\n\n${paragraph}` : paragraph;

    if (nextValue.length <= maxChars) {
      current = nextValue;
      return;
    }

    if (current) {
      chunks.push(current);
    }

    current = paragraph;
  });

  if (current) {
    chunks.push(current);
  }

  return chunks;
}

function buildSummaryPrompt(language, speechContext, mode = 'final') {
  const languageInstruction =
    language === 'hi'
      ? 'Write the full summary in Hindi.'
      : language === 'en'
        ? 'Write the full summary in English.'
        : 'Write the summary in the same language style as the transcript. If the speaker mixed Hindi and English, keep the summary naturally bilingual instead of forcing only one language.';

  const glossaryInstruction = speechContext
    ? `Preserve the exact spelling of these names or terms whenever they appear in the transcript or are clearly implied: ${speechContext}`
    : '';

  const modeInstruction =
    mode === 'chunk'
      ? 'You are summarizing only one excerpt of a much longer conversation. Capture only the facts from this excerpt and keep the output concise so it can be merged with other excerpt summaries later.'
      : 'You may be given either the full transcript or merged excerpt summaries from a longer conversation. Produce the best final meeting-style summary you can from the material provided.';

  return [SUMMARY_PROMPT, modeInstruction, languageInstruction, glossaryInstruction]
    .filter(Boolean)
    .join('\n\n');
}

async function summarizeText(sourceText, language, speechContext, mode) {
  const response = await fetch(`${API_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: SUMMARY_MODEL,
      temperature: 0.2,
      messages: [
        { role: 'system', content: buildSummaryPrompt(language, speechContext, mode) },
        { role: 'user', content: `Transcript material:\n\n${sourceText}` },
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

export async function summarizeTranscript(transcript, language, speechContext) {
  const initialChunks = splitTextForSummary(transcript);

  if (initialChunks.length <= 1) {
    return withProviderRetries(() =>
      summarizeText(initialChunks[0] || transcript, language, speechContext, 'final')
    );
  }

  let currentSources = initialChunks;

  for (let pass = 0; pass < MAX_SUMMARY_REDUCTION_PASSES; pass += 1) {
    const partialSummaries = [];

    for (let index = 0; index < currentSources.length; index += 1) {
      const partialSummary = await withProviderRetries(() =>
        summarizeText(currentSources[index], language, speechContext, 'chunk')
      );

      partialSummaries.push(`Excerpt ${index + 1}\n${partialSummary}`);
    }

    const combinedSummarySource = partialSummaries.join('\n\n');
    const reducedSources = splitTextForSummary(combinedSummarySource);

    if (reducedSources.length <= 1) {
      return withProviderRetries(() =>
        summarizeText(combinedSummarySource, language, speechContext, 'final')
      );
    }

    currentSources = reducedSources;
  }

  return withProviderRetries(() =>
    summarizeText(currentSources.join('\n\n'), language, speechContext, 'final')
  );
}

function escapeRegularExpression(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractSummarySection(summary, heading) {
  const sectionPattern = new RegExp(
    `##\\s+${escapeRegularExpression(heading)}\\s*([\\s\\S]*?)(?=\\n##\\s+|$)`,
    'i'
  );

  const match = summary.match(sectionPattern);
  return match?.[1]?.trim() || '';
}

function parseNumberedSection(sectionText) {
  const normalizedText = sectionText.trim();

  if (!normalizedText || /^none identified\.?$/i.test(normalizedText)) {
    return [];
  }

  return normalizedText
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^\d+[\).\s-]*/, '').trim())
    .filter(Boolean);
}

export function parseSummarySections(summary) {
  const actionItemsText = extractSummarySection(summary, 'Action Items');
  const keyDecisionsText = extractSummarySection(summary, 'Key Decisions');
  const overview = extractSummarySection(summary, 'Concise Overview');

  return {
    actionItems: parseNumberedSection(actionItemsText),
    keyDecisions: parseNumberedSection(keyDecisionsText),
    overview,
  };
}

export function buildWhatsAppSummaryMessage({
  summary,
  overview,
  actionItems,
  keyDecisions,
}) {
  const lines = ['Voice Note Brief'];

  if (overview) {
    lines.push('', 'Overview', overview);
  }

  lines.push('', 'Action Items');
  if (actionItems.length) {
    actionItems.forEach((item, index) => {
      lines.push(`${index + 1}. ${item}`);
    });
  } else {
    lines.push('None identified.');
  }

  lines.push('', 'Key Decisions');
  if (keyDecisions.length) {
    keyDecisions.forEach((item, index) => {
      lines.push(`${index + 1}. ${item}`);
    });
  } else {
    lines.push('None identified.');
  }

  const message = lines.join('\n').trim();
  return message.length > 40 ? message : summary.trim();
}

export async function analyzeVoiceNote({
  transcript,
  audioUrls,
  language = 'auto',
  speechContext = '',
}) {
  if (!process.env.GROQ_API_KEY) {
    throw new Error('GROQ_API_KEY is not configured on the server.');
  }

  const normalizedTranscript = normalizeTranscriptText(transcript);
  const normalizedAudioUrls = normalizeAudioUrls(audioUrls);
  const normalizedLanguage = normalizeLanguage(language);
  const normalizedSpeechContext = normalizeSpeechContext(speechContext);

  if (!normalizedTranscript && !normalizedAudioUrls.length) {
    throw new Error('Provide either transcript text or one or more public audio URLs.');
  }

  if (normalizedAudioUrls.length > MAX_AUDIO_CHUNKS) {
    throw new Error(
      `This request exceeds the supported chunk count of ${MAX_AUDIO_CHUNKS} audio segments.`
    );
  }

  const sourceType = normalizedTranscript ? 'transcript' : 'audio_urls';

  const resolvedTranscript = normalizedTranscript
    ? normalizedTranscript
    : await transcribeAudioUrls(normalizedAudioUrls, normalizedLanguage, normalizedSpeechContext);

  if (!resolvedTranscript) {
    throw new Error('No transcript generated.');
  }

  const summary = await summarizeTranscript(
    resolvedTranscript,
    normalizedLanguage,
    normalizedSpeechContext
  );
  const { actionItems, keyDecisions, overview } = parseSummarySections(summary);

  return {
    sourceType,
    transcript: resolvedTranscript,
    summary,
    actionItems,
    keyDecisions,
    overview,
    whatsappMessage: buildWhatsAppSummaryMessage({
      summary,
      overview,
      actionItems,
      keyDecisions,
    }),
    language: normalizedLanguage,
    chunkCount: normalizedAudioUrls.length,
  };
}

export {
  MAX_AUDIO_CHUNKS,
  MAX_SINGLE_AUDIO_BYTES,
  MAX_SPEECH_CONTEXT_CHARS,
};
