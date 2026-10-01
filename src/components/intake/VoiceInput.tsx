import { useState, useRef, useCallback } from 'react';
import { Mic, MicOff } from 'lucide-react';

interface Props {
  disabled?: boolean;
  onTranscript: (text: string) => void;
  label?: string;
  className?: string;
}

const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

export function VoiceInput({ disabled, onTranscript, label = 'Voice input', className = 'px-3 py-2 text-xs' }: Props) {
  const [listening, setListening] = useState(false);
  const [error, setError] = useState('');
  const recognitionRef = useRef<any>(null);

  const toggle = useCallback(() => {
    if (!SpeechRecognition) {
      setError('Speech recognition is not supported in this browser');
      return;
    }
    if (listening) {
      recognitionRef.current?.stop();
      setListening(false);
      return;
    }
    setError('');
    const recognition = new SpeechRecognition();
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.lang = '';
    recognition.onresult = (event: any) => {
      const transcript = event.results[0]?.[0]?.transcript;
      if (transcript) onTranscript(transcript);
      setListening(false);
    };
    recognition.onerror = (event: any) => {
      if (event.error !== 'aborted') setError(`Voice error: ${event.error}`);
      setListening(false);
    };
    recognition.onend = () => setListening(false);
    recognitionRef.current = recognition;
    recognition.start();
    setListening(true);
  }, [listening, onTranscript]);

  if (!SpeechRecognition) return null;

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={toggle}
        disabled={disabled}
        className={`flex items-center gap-1.5 ${className} rounded-lg border transition-colors cursor-pointer disabled:opacity-50 ${
          listening ? 'bg-danger/20 border-danger/50 text-danger' : 'border-border text-text-muted hover:text-text hover:border-accent'
        }`}
      >
        {listening ? <><MicOff className="w-3.5 h-3.5" /> Stop</> : <><Mic className="w-3.5 h-3.5" /> {label}</>}
      </button>
      {listening && <span className="text-xs text-text-dim animate-pulse">Listening…</span>}
      {error && <span className="text-xs text-danger">{error}</span>}
    </div>
  );
}
