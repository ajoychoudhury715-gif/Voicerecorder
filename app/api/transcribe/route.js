import { del } from '@vercel/blob';
import {
  MAX_AUDIO_CHUNKS,
  MAX_SINGLE_AUDIO_BYTES,
  analyzeVoiceNote,
  normalizeAudioUrls,
  normalizeLanguage,
  normalizeSpeechContext,
  sanitizeProviderErrorMessage,
  summarizeTranscript,
  transcribeUploadedAudioFile,
} from '../../../lib/voice-processing';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

async function cleanupUploadedAudio(audioUrls) {
  if (!process.env.BLOB_READ_WRITE_TOKEN || !audioUrls.length) {
    return;
  }

  await Promise.allSettled(audioUrls.map((audioUrl) => del(audioUrl)));
}

export async function POST(request) {
  if (!process.env.GROQ_API_KEY) {
    return Response.json(
      { error: 'GROQ_API_KEY is not configured on the server.' },
      { status: 500 }
    );
  }

  const contentType = request.headers.get('content-type') || '';
  let uploadedAudioUrls = [];

  try {
    if (contentType.includes('application/json')) {
      const body = await request.json();
      uploadedAudioUrls = normalizeAudioUrls(body?.audioUrls);
      const transcript = typeof body?.transcript === 'string' ? body.transcript : '';

      if (!transcript.trim() && !uploadedAudioUrls.length) {
        return Response.json(
          { error: 'Provide transcript text or at least one uploaded audio segment.' },
          { status: 400 }
        );
      }

      if (uploadedAudioUrls.length > MAX_AUDIO_CHUNKS) {
        return Response.json(
          { error: `This recording exceeds the supported chunk count of ${MAX_AUDIO_CHUNKS} segments.` },
          { status: 400 }
        );
      }

      const result = await analyzeVoiceNote({
        transcript,
        audioUrls: uploadedAudioUrls,
        language: body?.language,
        speechContext: body?.speechContext,
      });

      return Response.json({
        transcript: result.transcript,
        summary: result.summary,
        chunkCount: result.chunkCount || 1,
      });
    }

    const formData = await request.formData();
    const audioFile = formData.get('audio');
    const normalizedLanguage = normalizeLanguage(formData.get('language'));
    const speechContext = normalizeSpeechContext(formData.get('speechContext'));

    if (!(audioFile instanceof File)) {
      return Response.json({ error: 'No audio file provided.' }, { status: 400 });
    }

    if (audioFile.size === 0) {
      return Response.json({ error: 'The recorded audio file is empty.' }, { status: 400 });
    }

    if (audioFile.size > MAX_SINGLE_AUDIO_BYTES) {
      return Response.json(
        { error: 'The uploaded audio file is too large for direct processing. Please record again using segmented uploads.' },
        { status: 400 }
      );
    }

    const transcript = await transcribeUploadedAudioFile(
      audioFile,
      normalizedLanguage,
      speechContext
    );

    if (!transcript) {
      return Response.json({ error: 'No transcript generated.' }, { status: 400 });
    }

    const summary = await summarizeTranscript(transcript, normalizedLanguage, speechContext);
    return Response.json({
      transcript,
      summary,
      chunkCount: 1,
    });
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
  } finally {
    await cleanupUploadedAudio(uploadedAudioUrls);
  }
}
