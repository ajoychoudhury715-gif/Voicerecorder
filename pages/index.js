import { useRef, useState } from 'react';

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
      alert(message);
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
      alert(message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ padding: '20px', fontFamily: 'Arial, sans-serif' }}>
      <h1>Voice Summary Tool</h1>
      <p>Record your voice, get a transcript and summary using AI.</p>
      <button onClick={recording ? stopRecording : startRecording} disabled={loading}>
        {recording ? 'Stop Recording' : 'Start Recording'}
      </button>
      {loading && <p>Processing...</p>}
      {error && <p style={{ color: '#b00020' }}>{error}</p>}
      {transcript && (
        <div>
          <h2>Transcript</h2>
          <p style={{ whiteSpace: 'pre-wrap' }}>{transcript}</p>
        </div>
      )}
      {summary && (
        <div>
          <h2>Summary</h2>
          <p style={{ whiteSpace: 'pre-wrap' }}>{summary}</p>
        </div>
      )}
    </div>
  );
}
