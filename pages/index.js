import { upload } from '@vercel/blob/client';
import { useRef, useState } from 'react';
import styles from '../styles/Home.module.css';

const AUDIO_MIME_TYPES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',
  'audio/ogg;codecs=opus',
];
const LANGUAGE_OPTIONS = [
  { value: 'auto', label: 'Hindi + English' },
  { value: 'hi', label: 'Hindi' },
  { value: 'en', label: 'English' },
];
const MICROPHONE_CONSTRAINTS = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  channelCount: { ideal: 1 },
  sampleRate: { ideal: 16000 },
  sampleSize: { ideal: 16 },
};
const MAX_SPEECH_CONTEXT_LENGTH = 500;
const TARGET_AUDIO_BITS_PER_SECOND = 64000;
const RECORDING_CHUNK_TIMESLICE_MS = 15 * 60 * 1000;
const MAX_BLOB_CHUNK_BYTES = 20 * 1024 * 1024;

function createRecordingSessionId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  return `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function getFileExtensionForMimeType(mimeType) {
  if (mimeType.includes('mp4')) {
    return 'mp4';
  }

  if (mimeType.includes('ogg')) {
    return 'ogg';
  }

  if (mimeType.includes('wav')) {
    return 'wav';
  }

  return 'webm';
}

function getSupportedAudioConfig() {
  if (typeof window === 'undefined' || typeof MediaRecorder === 'undefined') {
    return { mimeType: '', extension: 'webm' };
  }

  const mimeType = AUDIO_MIME_TYPES.find((type) => MediaRecorder.isTypeSupported(type)) || '';
  return { mimeType, extension: getFileExtensionForMimeType(mimeType) };
}

const WHATSAPP_PREFILL_LIMIT = 3200;

export default function Home() {
  const [recording, setRecording] = useState(false);
  const [paused, setPaused] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [summary, setSummary] = useState('');
  const [loading, setLoading] = useState(false);
  const [processingStage, setProcessingStage] = useState('idle');
  const [error, setError] = useState('');
  const [shareNotice, setShareNotice] = useState('');
  const [whatsAppNumber, setWhatsAppNumber] = useState('');
  const [languageMode, setLanguageMode] = useState('auto');
  const [speechContext, setSpeechContext] = useState('');
  const [uploadedChunkCount, setUploadedChunkCount] = useState(0);
  const mediaRecorderRef = useRef(null);
  const audioConfigRef = useRef({ mimeType: '', extension: 'webm' });
  const uploadQueueRef = useRef(Promise.resolve());
  const uploadErrorRef = useRef(null);
  const uploadedChunksRef = useRef([]);
  const chunkSequenceRef = useRef(0);
  const sessionKeyRef = useRef('');
  const waveformBars = [32, 58, 44, 68, 40, 72, 52, 64, 38, 70, 46, 60];

  const resetRecordingSession = () => {
    sessionKeyRef.current = createRecordingSessionId();
    uploadQueueRef.current = Promise.resolve();
    uploadErrorRef.current = null;
    uploadedChunksRef.current = [];
    chunkSequenceRef.current = 0;
    setUploadedChunkCount(0);
  };

  const uploadAudioChunk = async (audioChunk, mimeType, extension) => {
    if (audioChunk.size === 0) {
      return;
    }

    if (audioChunk.size > MAX_BLOB_CHUNK_BYTES) {
      throw new Error('A recording segment became too large to upload safely. Please stop and try again.');
    }

    const chunkNumber = chunkSequenceRef.current + 1;
    chunkSequenceRef.current = chunkNumber;

    const pathname = `recordings/${sessionKeyRef.current}/chunk-${String(chunkNumber).padStart(4, '0')}.${extension}`;
    const blob = await upload(pathname, audioChunk, {
      access: 'public',
      contentType: mimeType || 'audio/webm',
      handleUploadUrl: '/api/audio/upload',
      clientPayload: JSON.stringify({
        sessionKey: sessionKeyRef.current,
        chunkNumber,
      }),
    });

    uploadedChunksRef.current.push({
      chunkNumber,
      url: blob.url,
    });
    uploadedChunksRef.current.sort((left, right) => left.chunkNumber - right.chunkNumber);
    setUploadedChunkCount(uploadedChunksRef.current.length);
  };

  const enqueueChunkUpload = (audioChunk) => {
    const { mimeType, extension } = audioConfigRef.current;
    const nextUpload = uploadQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        if (uploadErrorRef.current) {
          return;
        }

        await uploadAudioChunk(audioChunk, mimeType, extension);
      });

    uploadQueueRef.current = nextUpload.catch((uploadError) => {
      uploadErrorRef.current = uploadError;
      console.error('Chunk upload failed:', uploadError);
    });
  };

  const startRecording = async () => {
    try {
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
        throw new Error('This browser does not support audio recording.');
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: MICROPHONE_CONSTRAINTS,
      });
      const audioConfig = getSupportedAudioConfig();
      const mediaRecorderOptions = {
        audioBitsPerSecond: TARGET_AUDIO_BITS_PER_SECOND,
      };

      if (audioConfig.mimeType) {
        mediaRecorderOptions.mimeType = audioConfig.mimeType;
      }

      const mediaRecorder = new MediaRecorder(stream, mediaRecorderOptions);
      const resolvedMimeType = mediaRecorder.mimeType || audioConfig.mimeType;

      resetRecordingSession();
      mediaRecorderRef.current = mediaRecorder;
      audioConfigRef.current = {
        mimeType: resolvedMimeType,
        extension: getFileExtensionForMimeType(resolvedMimeType),
      };
      setPaused(false);
      setLoading(false);
      setProcessingStage('idle');
      setShareNotice('');
      setError('');
      setTranscript('');
      setSummary('');

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          enqueueChunkUpload(event.data);
        }
      };

      mediaRecorder.onstop = async () => {
        setPaused(false);
        setLoading(true);
        setProcessingStage('uploading');
        setShareNotice('');
        setError('');

        try {
          await uploadQueueRef.current;

          if (uploadErrorRef.current) {
            throw uploadErrorRef.current;
          }

          if (!uploadedChunksRef.current.length) {
            throw new Error('No audio was captured. Please try another take.');
          }

          await processAudio({
            audioUrls: uploadedChunksRef.current.map((chunk) => chunk.url),
          });
        } catch (processingError) {
          console.error('Error preparing audio:', processingError);
          const message =
            processingError instanceof Error
              ? processingError.message
              : 'Error preparing the recording for transcription.';
          setError(message);
        } finally {
          setLoading(false);
          setProcessingStage('idle');
          stream.getTracks().forEach(track => track.stop());
        }
      };

      mediaRecorder.start(RECORDING_CHUNK_TIMESLICE_MS);
      setRecording(true);
    } catch (error) {
      console.error('Error accessing microphone:', error);
      const message = error.message || 'Microphone access denied or not available.';
      setError(message);
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && recording) {
      mediaRecorderRef.current.stop();
      setRecording(false);
      setPaused(false);
    }
  };

  const togglePauseRecording = () => {
    const mediaRecorder = mediaRecorderRef.current;

    if (!mediaRecorder || !recording) {
      return;
    }

    if (paused) {
      mediaRecorder.resume();
      setPaused(false);
      return;
    }

    mediaRecorder.pause();
    setPaused(true);
  };

  const processAudio = async ({ audioUrls }) => {
    try {
      setProcessingStage('transcribing');
      const response = await fetch('/api/transcribe', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          audioUrls,
          language: languageMode,
          speechContext: speechContext.trim(),
        }),
      });

      const rawBody = await response.text();
      let data = null;

      if (rawBody) {
        try {
          data = JSON.parse(rawBody);
        } catch {
          data = null;
        }
      }

      if (!response.ok) {
        throw new Error(
          data?.error ||
            rawBody.trim() ||
            `Audio processing failed with status ${response.status}.`
        );
      }

      setProcessingStage('summarizing');
      setTranscript(data?.transcript || '');
      setSummary(data?.summary || '');
    } catch (error) {
      console.error('Error:', error);
      const message = error.message || 'Error processing audio';
      setError(message);
    }
  };

  const buildExportText = (type) => {
    const exportedAt = new Date().toLocaleString();
    const sections = ['Voice Note Studio Export', `Created: ${exportedAt}`];

    if (type !== 'summary' && transcript) {
      sections.push(`Transcript\n${transcript}`);
    }

    if (type !== 'transcript' && summary) {
      sections.push(`Summary\n${summary}`);
    }

    return sections.join('\n\n');
  };

  const buildWhatsAppUrl = (text) => {
    const cleanNumber = whatsAppNumber.replace(/\D/g, '');
    const baseUrl = cleanNumber ? `https://wa.me/${cleanNumber}` : 'https://wa.me/';
    const query = new URLSearchParams({ text });
    return `${baseUrl}?${query.toString()}`;
  };

  const copyExportText = async (text) => {
    if (!navigator.clipboard?.writeText) {
      throw new Error('Clipboard access is not available in this browser.');
    }

    await navigator.clipboard.writeText(text);
  };

  const handleWhatsAppExport = async (type) => {
    const exportText = buildExportText(type);

    if (!exportText.trim()) {
      setShareNotice('Record audio first so there is something to export.');
      return;
    }

    const popup = window.open('', '_blank', 'noopener,noreferrer');
    const label =
      type === 'summary' ? 'summary' : type === 'transcript' ? 'transcript' : 'full notes';

    try {
      if (exportText.length > WHATSAPP_PREFILL_LIMIT) {
        await copyExportText(exportText);

        if (popup) {
          popup.location.href = buildWhatsAppUrl(
            'Your Voice Note Studio export is copied. Paste it here to send the full notes.'
          );
        }

        setShareNotice(
          `The ${label} was copied to your clipboard because it is too long to prefill safely in WhatsApp. Paste it into the chat after WhatsApp opens.`
        );
        return;
      }

      if (popup) {
        popup.location.href = buildWhatsAppUrl(exportText);
      } else {
        window.open(buildWhatsAppUrl(exportText), '_blank', 'noopener,noreferrer');
      }

      setShareNotice(`Opened WhatsApp with the ${label} ready to send.`);
    } catch (shareError) {
      if (popup && !popup.closed) {
        popup.close();
      }

      console.error('WhatsApp export failed:', shareError);
      setShareNotice(
        shareError instanceof Error
          ? shareError.message
          : 'Could not prepare the WhatsApp export.'
      );
    }
  };

  const handleCopyExport = async () => {
    const exportText = buildExportText('all');

    if (!exportText.trim()) {
      setShareNotice('Record audio first so there is something to copy.');
      return;
    }

    try {
      await copyExportText(exportText);
      setShareNotice('Transcript and summary copied to your clipboard.');
    } catch (copyError) {
      console.error('Copy failed:', copyError);
      setShareNotice(
        copyError instanceof Error ? copyError.message : 'Could not copy the export text.'
      );
    }
  };

  const hasResults = Boolean(transcript || summary);
  const processedSegmentCount = uploadedChunkCount || 1;
  const statusLabel = (() => {
    if (error) {
      return 'Attention needed';
    }

    if (loading) {
      if (processingStage === 'uploading') {
        return 'Uploading audio';
      }

      if (processingStage === 'transcribing') {
        return 'Transcribing audio';
      }

      if (processingStage === 'summarizing') {
        return 'Generating summary';
      }

      return 'Processing';
    }

    if (paused) {
      return 'Recording paused';
    }

    if (recording) {
      return 'Recording live';
    }

    if (hasResults) {
      return 'Ready for another take';
    }

    return 'Ready to record';
  })();

  const statusClassName = [
    styles.statusPill,
    error
      ? styles.statusError
      : loading
        ? styles.statusLoading
        : paused
          ? styles.statusPaused
        : recording
          ? styles.statusRecording
          : styles.statusReady,
  ].join(' ');

  const helperText = error
    ? error
    : loading
      ? processingStage === 'uploading'
        ? `Uploading ${processedSegmentCount} recorded segment${processedSegmentCount === 1 ? '' : 's'} from secure browser storage.`
        : processingStage === 'transcribing'
          ? `Transcribing ${processedSegmentCount} audio segment${processedSegmentCount === 1 ? '' : 's'} now.`
          : 'Building a structured summary from the full conversation.'
      : paused
        ? 'Recording is paused. Resume when you want to keep adding audio, or finish the take now.'
      : recording
        ? `Speak naturally and keep the microphone close. Long recordings are split into ${Math.round(RECORDING_CHUNK_TIMESLICE_MS / 60000)} minute audio segments and uploaded in the background.`
        : 'Add language mode or speech context first if you expect names, jargon, or mixed Hinglish, then start recording.';

  const primaryButtonLabel = recording
    ? 'Finish Recording'
    : loading
      ? 'Processing...'
      : 'Start Recording';
  const pauseButtonLabel = paused ? 'Resume Recording' : 'Pause Recording';

  return (
    <div className={styles.page}>
      <div className={styles.orbOne} aria-hidden="true" />
      <div className={styles.orbTwo} aria-hidden="true" />
      <div className={styles.gridGlow} aria-hidden="true" />

      <main className={styles.shell}>
        <section className={styles.heroSection}>
          <aside className={styles.controlPanel}>
            <div className={styles.panelTop}>
              <div>
                <p className={styles.panelLabel}>Recorder</p>
                <h2 className={styles.panelTitle}>Speak now, process in one pass</h2>
              </div>
              <div className={statusClassName}>
                <span className={styles.statusDot} />
                <span>{statusLabel}</span>
              </div>
            </div>

            <div className={styles.waveform} aria-hidden="true">
              {waveformBars.map((height, index) => (
                <span
                  key={index}
                  className={[
                    styles.waveBar,
                    (recording && !paused) || loading ? styles.waveActive : '',
                  ].join(' ')}
                  style={{
                    '--bar-height': `${height}%`,
                    animationDelay: `${index * 80}ms`,
                  }}
                />
              ))}
            </div>

            <div className={styles.controlActions}>
              <button
                className={[
                  styles.primaryButton,
                  recording ? styles.stopButton : styles.startButton,
                ].join(' ')}
                onClick={recording ? stopRecording : startRecording}
                disabled={loading}
              >
                <span
                  className={[
                    styles.buttonIcon,
                    recording ? styles.buttonIconStop : styles.buttonIconStart,
                  ].join(' ')}
                  aria-hidden="true"
                />
                <span>{primaryButtonLabel}</span>
              </button>

              {recording && (
                <button
                  type="button"
                  className={[
                    styles.secondaryButton,
                    paused ? styles.resumeButton : styles.pauseButton,
                  ].join(' ')}
                  onClick={togglePauseRecording}
                  disabled={loading}
                >
                  <span
                    className={[
                      styles.secondaryButtonIcon,
                      paused ? styles.buttonIconResume : styles.buttonIconPause,
                    ].join(' ')}
                    aria-hidden="true"
                  />
                  <span>{pauseButtonLabel}</span>
                </button>
              )}
            </div>

            <p className={styles.helperText}>{helperText}</p>

            {error && (
              <div className={styles.errorBanner} role="alert">
                <strong>Audio processing issue</strong>
                <p>{error}</p>
              </div>
            )}

            <div className={styles.panelMeta}>
              <div className={styles.metaItem}>
                <span className={styles.metaLabel}>Format</span>
                <strong>{(audioConfigRef.current.extension || 'webm').toUpperCase()}</strong>
              </div>
              <div className={styles.metaItem}>
                <span className={styles.metaLabel}>Language</span>
                <strong>{LANGUAGE_OPTIONS.find((option) => option.value === languageMode)?.label}</strong>
              </div>
              <div className={styles.metaItem}>
                <span className={styles.metaLabel}>Segments</span>
                <strong>{uploadedChunkCount ? uploadedChunkCount : recording || loading ? 'Streaming' : 'Waiting'}</strong>
              </div>
              <div className={styles.metaItem}>
                <span className={styles.metaLabel}>Transcript</span>
                <strong>{transcript ? 'Ready' : 'Waiting'}</strong>
              </div>
              <div className={styles.metaItem}>
                <span className={styles.metaLabel}>Summary</span>
                <strong>{summary ? 'Ready' : 'Waiting'}</strong>
              </div>
            </div>

            <div className={styles.languagePanel}>
              <div className={styles.languageHeader}>
                <span className={styles.languageEyebrow}>Language Mode</span>
                <p className={styles.languageHint}>
                  Use mixed mode for Hinglish conversations. Choose a single language to improve transcription accuracy and speed.
                </p>
              </div>
              <div className={styles.languageOptions}>
                {LANGUAGE_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    className={[
                      styles.languageOption,
                      languageMode === option.value ? styles.languageOptionActive : '',
                    ].join(' ')}
                    onClick={() => setLanguageMode(option.value)}
                    disabled={loading || recording}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>

            <div className={styles.accuracyPanel}>
              <div className={styles.accuracyHeader}>
                <span className={styles.accuracyEyebrow}>Speech Context</span>
                <p className={styles.accuracyHint}>
                  Add names, brand terms, abbreviations, or project jargon before you
                  record. These preferred spellings are sent with the audio to reduce
                  recognition mistakes.
                </p>
              </div>

              <label className={styles.contextField}>
                <span className={styles.contextLabel}>Names, products, jargon</span>
                <textarea
                  className={styles.contextInput}
                  placeholder="Examples: Ajoy Choudhury, Groq, Vercel, Q4 roadmap, standup, HSR Layout"
                  value={speechContext}
                  maxLength={MAX_SPEECH_CONTEXT_LENGTH}
                  onChange={(event) => setSpeechContext(event.target.value)}
                  disabled={loading}
                />
              </label>

              <div className={styles.contextMeta}>
                <span>{speechContext.trim().length}/{MAX_SPEECH_CONTEXT_LENGTH} characters</span>
                <span>Accuracy-first mode is enabled</span>
              </div>

              <p className={styles.contextFootnote}>
                We can improve transcription quality a lot, especially for mixed Hindi-English
                audio and unusual names, but no speech model can guarantee literal 100%
                accuracy on every recording.
              </p>
            </div>
          </aside>
        </section>

        <section className={styles.resultsSection} aria-live="polite">
          <div className={styles.resultsHeader}>
            <div>
              <p className={styles.sectionEyebrow}>Session Output</p>
              <h2 className={styles.sectionTitle}>Readable notes, not a wall of text</h2>
            </div>
            <p className={styles.sectionHint}>
              Your recording stays on the page until you start a new take.
            </p>
          </div>

          {hasResults && (
            <div className={styles.exportPanel}>
              <div className={styles.exportIntro}>
                <p className={styles.exportEyebrow}>WhatsApp Export</p>
                <h3 className={styles.exportTitle}>Send transcript and summary straight to chat</h3>
                <p className={styles.exportText}>
                  Add a WhatsApp number with country code if you want to open a specific chat, or
                  leave it blank to choose inside WhatsApp. Long exports are copied to your
                  clipboard automatically when needed.
                </p>
              </div>

              <div className={styles.exportTools}>
                <label className={styles.exportField}>
                  <span className={styles.exportFieldLabel}>WhatsApp Number</span>
                  <input
                    className={styles.exportInput}
                    type="tel"
                    inputMode="tel"
                    placeholder="Optional, e.g. 919876543210"
                    value={whatsAppNumber}
                    onChange={(event) => setWhatsAppNumber(event.target.value)}
                  />
                </label>

                <div className={styles.exportActions}>
                  <button
                    type="button"
                    className={styles.exportButton}
                    onClick={() => handleWhatsAppExport('summary')}
                  >
                    WhatsApp Summary
                  </button>
                  <button
                    type="button"
                    className={styles.exportButton}
                    onClick={() => handleWhatsAppExport('transcript')}
                  >
                    WhatsApp Transcript
                  </button>
                  <button
                    type="button"
                    className={[styles.exportButton, styles.exportPrimary].join(' ')}
                    onClick={() => handleWhatsAppExport('all')}
                  >
                    WhatsApp Full Notes
                  </button>
                  <button
                    type="button"
                    className={styles.exportButtonSecondary}
                    onClick={handleCopyExport}
                  >
                    Copy Full Notes
                  </button>
                </div>

                <p className={styles.exportNotice}>{shareNotice || ' '}</p>
              </div>
            </div>
          )}

          <div className={styles.resultsGrid}>
            <article className={styles.resultCard}>
              <div className={styles.resultTop}>
                <span className={styles.resultTag}>Raw transcript</span>
                <h3 className={styles.resultTitle}>Everything that was said</h3>
              </div>
              <div
                className={[
                  styles.resultBody,
                  transcript ? '' : styles.resultPlaceholder,
                ].join(' ')}
              >
                {transcript ||
                  'Your transcript will appear here after the recording is processed. Use it to review details, wording, and context before you share anything.'}
              </div>
            </article>

            <article className={[styles.resultCard, styles.summaryCard].join(' ')}>
              <div className={styles.resultTop}>
                <span className={[styles.resultTag, styles.summaryTag].join(' ')}>
                  Structured summary
                </span>
                <h3 className={styles.resultTitle}>What matters next</h3>
              </div>
              <div
                className={[
                  styles.resultBody,
                  summary ? '' : styles.resultPlaceholder,
                ].join(' ')}
              >
                {summary ||
                  'Action items, key decisions, and a concise overview will appear here once the AI finishes shaping your notes.'}
              </div>
            </article>
          </div>
        </section>
      </main>
    </div>
  );
}
