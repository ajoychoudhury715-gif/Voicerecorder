import { useRef, useState } from 'react';
import styles from '../styles/Home.module.css';

const AUDIO_MIME_TYPES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',
  'audio/ogg;codecs=opus',
];

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

export default function Home() {
  const [recording, setRecording] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [summary, setSummary] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const audioConfigRef = useRef({ mimeType: '', extension: 'webm' });
  const waveformBars = [32, 58, 44, 68, 40, 72, 52, 64, 38, 70, 46, 60];

  const startRecording = async () => {
    try {
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
        throw new Error('This browser does not support audio recording.');
      }

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const audioConfig = getSupportedAudioConfig();
      const mediaRecorder = audioConfig.mimeType
        ? new MediaRecorder(stream, { mimeType: audioConfig.mimeType })
        : new MediaRecorder(stream);
      const resolvedMimeType = mediaRecorder.mimeType || audioConfig.mimeType;

      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];
      audioConfigRef.current = {
        mimeType: resolvedMimeType,
        extension: getFileExtensionForMimeType(resolvedMimeType),
      };
      setError('');
      setTranscript('');
      setSummary('');

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      mediaRecorder.onstop = async () => {
        const { mimeType, extension } = audioConfigRef.current;
        const audioBlob = new Blob(audioChunksRef.current, {
          type: mimeType || 'audio/webm',
        });

        await processAudio(audioBlob, `recording.${extension}`);
        stream.getTracks().forEach(track => track.stop());
      };

      mediaRecorder.start();
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
    }
  };

  const processAudio = async (audioBlob, fileName) => {
    setLoading(true);
    setError('');

    const formData = new FormData();
    formData.append('audio', audioBlob, fileName);

    try {
      const response = await fetch('/api/transcribe', {
        method: 'POST',
        body: formData,
      });

      const data = await response.json().catch(() => null);

      if (!response.ok) {
        throw new Error(data?.error || 'Error processing audio');
      }

      setTranscript(data?.transcript || '');
      setSummary(data?.summary || '');
    } catch (error) {
      console.error('Error:', error);
      const message = error.message || 'Error processing audio';
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  const hasResults = Boolean(transcript || summary);
  const statusLabel = error
    ? 'Attention needed'
    : loading
      ? 'Generating notes'
      : recording
        ? 'Recording live'
        : hasResults
          ? 'Ready for another take'
          : 'Ready to record';

  const statusClassName = [
    styles.statusPill,
    error
      ? styles.statusError
      : loading
        ? styles.statusLoading
        : recording
          ? styles.statusRecording
          : styles.statusReady,
  ].join(' ');

  const helperText = error
    ? error
    : loading
      ? 'Transcribing your recording and shaping the summary now.'
      : recording
        ? 'Speak naturally. Everything is sent only after you stop the recording.'
        : 'Tap once to start recording, then tap again when you are ready for notes.';

  const primaryButtonLabel = recording
    ? 'Finish Recording'
    : loading
      ? 'Processing...'
      : 'Start Recording';

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
                    recording || loading ? styles.waveActive : '',
                  ].join(' ')}
                  style={{
                    '--bar-height': `${height}%`,
                    animationDelay: `${index * 80}ms`,
                  }}
                />
              ))}
            </div>

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
                <span className={styles.metaLabel}>Transcript</span>
                <strong>{transcript ? 'Ready' : 'Waiting'}</strong>
              </div>
              <div className={styles.metaItem}>
                <span className={styles.metaLabel}>Summary</span>
                <strong>{summary ? 'Ready' : 'Waiting'}</strong>
              </div>
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
