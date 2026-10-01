import { useState } from 'react';
import {
  Send, Loader2, Languages, AlertTriangle, MapPin, Users, Info, CheckCircle, CloudOff, GitMerge, Navigation,
} from 'lucide-react';
import { INCIDENT_TYPE_CONFIG, LOCATION_SOURCE_LABEL } from '../../utils/helpers';
import { uuid } from '../../lib/http';
import { submitOrQueue } from '../../lib/offlineQueue';
import type { ReportResult } from '../../lib/data';
import { VoiceInput } from './VoiceInput';

const SAMPLE_MESSAGES = [
  { lang: 'English', text: 'Major fire broke out in Dharavi near the railway line. About 20 shanties burning. Children are trapped on upper floors. Need fire trucks urgently!' },
  { lang: 'Hindi', text: 'सायन-माटुंगा रोड पर बाढ़ का पानी भर गया है। गाड़ियां फंसी हुई हैं। कम से कम 15 लोग फंसे हैं। बुजुर्ग लोग भी हैं।' },
  { lang: 'Marathi', text: 'भेंडी बाजार जवळ इमारत कोसळली. ३० लोक अडकले आहेत. मुलं आणि वृद्ध आहेत. तातडीने मदत पाठवा!' },
];

type Outcome = { kind: 'sent'; data: ReportResult } | { kind: 'queued' };

export function IntakeForm({ onSubmitted }: { onSubmitted?: (result: ReportResult) => void }) {
  const [message, setMessage] = useState('');
  const [source, setSource] = useState('phone');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [loading, setLoading] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [error, setError] = useState('');
  const [gpsEnabled, setGpsEnabled] = useState(false);
  const [gpsCoords, setGpsCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [gpsError, setGpsError] = useState('');
  const [gpsLoading, setGpsLoading] = useState(false);

  const toggleGps = () => {
    if (gpsEnabled) {
      setGpsEnabled(false);
      setGpsCoords(null);
      setGpsError('');
      return;
    }
    if (!navigator.geolocation) {
      setGpsError('GPS not supported by your browser');
      return;
    }
    setGpsEnabled(true);
    setGpsLoading(true);
    setGpsError('');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setGpsCoords({ lat: pos.coords.latitude, lng: pos.coords.longitude });
        setGpsLoading(false);
      },
      (err) => {
        setGpsError(err.code === 1 ? 'Location permission denied' : 'Could not get location');
        setGpsLoading(false);
        setGpsEnabled(false);
      },
      { enableHighAccuracy: true, timeout: 10000 },
    );
  };

  const handleSubmit = async () => {
    if (!message.trim()) return;
    setLoading(true);
    setError('');
    setOutcome(null);

    try {
      const result = await submitOrQueue({
        raw_message: message.trim(),
        source,
        reporter_name: name.trim() || undefined,
        reporter_phone: phone.trim() || undefined,
        reporter_lat: gpsCoords?.lat,
        reporter_lng: gpsCoords?.lng,
        client_id: uuid(),
        reported_at: new Date().toISOString(),
      });
      if (result.status === 'sent') {
        setOutcome({ kind: 'sent', data: result.result });
        onSubmitted?.(result.result);
      } else {
        setOutcome({ kind: 'queued' });
      }
      setMessage('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const data = outcome?.kind === 'sent' ? outcome.data : null;
  const result = data?.classification ?? null;
  const incident = data?.incident;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <div className="space-y-3">
        <div className="flex items-center gap-2 flex-wrap">
          <Languages className="w-5 h-5 text-accent" />
          <h3 className="text-sm font-semibold">AI multilingual intake</h3>
          <span className="text-[10px] text-text-dim bg-bg px-2 py-0.5 rounded-full border border-border">Language detected automatically</span>
        </div>

        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="Describe the emergency in any language — what happened, where exactly (building, street, landmark), how many people…"
          className="w-full h-36 bg-bg border border-border rounded-lg px-3 py-2 text-base sm:text-sm text-text placeholder-text-dim focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent resize-none"
          maxLength={5000}
        />

        <VoiceInput
          disabled={loading}
          onTranscript={(text) => {
            setMessage((m) => (m.trim() ? `${m.trim()} ${text}` : text));
            setSource((s) => (s === 'manual' ? 'voice' : s));
          }}
        />

        <div className="flex gap-1 flex-wrap items-center">
          <span className="text-[10px] text-text-dim mr-1">Try:</span>
          {SAMPLE_MESSAGES.map((s) => (
            <button
              key={s.lang}
              type="button"
              onClick={() => setMessage(s.text)}
              className="px-2 py-1 text-[10px] bg-bg-card border border-border rounded-full text-text-muted hover:text-text hover:border-accent transition-colors cursor-pointer"
            >
              {s.lang} sample
            </button>
          ))}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          <select
            value={source}
            onChange={(e) => setSource(e.target.value)}
            className="bg-bg border border-border rounded-lg px-2 py-2 text-sm sm:text-xs text-text focus:outline-none focus:border-accent cursor-pointer"
            aria-label="Report source"
          >
            <option value="phone">Phone call</option>
            <option value="manual">Manual entry</option>
            <option value="social">Social media</option>
            <option value="field_app">Field unit</option>
            <option value="voice">Voice</option>
          </select>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Reporter name" maxLength={100}
            className="bg-bg border border-border rounded-lg px-2 py-2 text-sm sm:text-xs text-text placeholder-text-dim focus:outline-none focus:border-accent" />
          <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="Phone" inputMode="tel" maxLength={30}
            className="bg-bg border border-border rounded-lg px-2 py-2 text-sm sm:text-xs text-text placeholder-text-dim focus:outline-none focus:border-accent" />
        </div>

        <label className="flex items-center gap-2 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={gpsEnabled}
            onChange={toggleGps}
            className="w-4 h-4 rounded border-border accent-accent cursor-pointer"
          />
          <Navigation className={`w-4 h-4 ${gpsEnabled ? 'text-success' : 'text-text-dim'}`} />
          <span className="text-sm sm:text-xs text-text-muted">Attach my GPS location</span>
          {gpsLoading && <Loader2 className="w-3 h-3 animate-spin text-accent" />}
          {gpsCoords && <span className="text-[10px] text-success">({gpsCoords.lat.toFixed(4)}, {gpsCoords.lng.toFixed(4)})</span>}
          {gpsError && <span className="text-[10px] text-danger">{gpsError}</span>}
        </label>

        <button
          onClick={handleSubmit}
          disabled={loading || !message.trim()}
          className="w-full flex items-center justify-center gap-2 px-4 py-3 sm:py-2.5 bg-accent text-white rounded-lg font-medium hover:bg-accent-hover transition-colors disabled:opacity-50 cursor-pointer"
        >
          {loading ? <><Loader2 className="w-4 h-4 animate-spin" /> Analyzing with AI…</> : <><Send className="w-4 h-4" /> Submit & classify</>}
        </button>

        {error && (
          <div className="flex items-center gap-2 p-2 bg-danger/10 border border-danger/30 rounded-lg text-xs text-danger">
            <AlertTriangle className="w-4 h-4 flex-shrink-0" /> {error}
          </div>
        )}
      </div>

      <div className="bg-bg border border-border rounded-xl p-4 min-h-48">
        {!outcome && !loading && (
          <div className="h-full flex items-center justify-center text-text-dim text-sm">
            <div className="text-center">
              <Info className="w-8 h-8 mx-auto mb-2 opacity-50" />
              <p>AI extraction results will appear here</p>
              <p className="text-xs mt-1">Reports are saved on this device if you are offline</p>
            </div>
          </div>
        )}

        {loading && (
          <div className="h-full flex items-center justify-center">
            <div className="text-center">
              <Loader2 className="w-8 h-8 mx-auto mb-2 animate-spin text-accent" />
              <p className="text-sm text-text-muted">Analyzing report…</p>
              <p className="text-xs text-text-dim mt-1">Detecting language, extracting facts, checking duplicates</p>
            </div>
          </div>
        )}

        {outcome?.kind === 'queued' && (
          <div className="h-full flex items-center justify-center">
            <div className="text-center space-y-1">
              <CloudOff className="w-8 h-8 mx-auto text-warning" />
              <p className="text-sm font-semibold text-warning">Saved on this device</p>
              <p className="text-xs text-text-muted max-w-xs">The server can't be reached right now. The report will upload automatically when the connection is back.</p>
            </div>
          </div>
        )}

        {data && incident && (
          <div className="space-y-3">
            <div className="flex items-center gap-2 flex-wrap">
              <CheckCircle className="w-5 h-5 text-success" />
              <span className="text-sm font-semibold text-success">Classification complete</span>
              {result && (
                <span className={`text-[10px] px-2 py-0.5 rounded-full border ${result.classifier === 'gemini' ? 'border-accent/40 text-accent' : 'border-warning/40 text-warning'}`}>
                  {result.classifier === 'gemini' ? 'Gemini AI' : 'Keyword fallback'}
                </span>
              )}
              {result && <span className="text-[10px] text-text-dim">{result.language === 'hi' ? 'Hindi' : result.language === 'mr' ? 'Marathi' : 'English'} detected</span>}
            </div>

            {data.is_duplicate && (
              <div className="flex items-start gap-2 p-2 rounded-lg bg-accent/10 border border-accent/30 text-xs text-accent">
                <GitMerge className="w-4 h-4 flex-shrink-0" />
                Same emergency as an existing incident — added as a corroborating report ({incident.corroborating_reports} reports).
              </div>
            )}

            <div>
              <div className="text-[10px] text-text-dim mb-0.5">{INCIDENT_TYPE_CONFIG[incident.type]?.icon} {INCIDENT_TYPE_CONFIG[incident.type]?.label}</div>
              <div className="text-sm font-medium">{incident.title}</div>
              {incident.description && <div className="text-xs text-text-muted mt-0.5">{incident.description}</div>}
            </div>

            <div className={`flex items-center gap-1.5 text-xs ${incident.location_source === 'unverified' ? 'text-warning' : 'text-text-muted'}`}>
              <MapPin className="w-3 h-3 flex-shrink-0" />
              <span>
                {incident.location_name ?? 'Unknown location'}
                {incident.location_source && ` · ${LOCATION_SOURCE_LABEL[incident.location_source]}`}
              </span>
            </div>

            <div className="grid grid-cols-2 gap-2 text-xs">
              <div className="bg-bg-card rounded-lg p-2 text-center">
                <Users className="w-3 h-3 mx-auto mb-1 text-text-dim" />
                <div className="font-medium">{incident.people_affected}</div>
                <div className="text-[10px] text-text-dim">Affected</div>
              </div>
              <div className="bg-bg-card rounded-lg p-2 text-center">
                <AlertTriangle className="w-3 h-3 mx-auto mb-1 text-danger" />
                <div className="font-medium">{incident.injuries}</div>
                <div className="text-[10px] text-text-dim">Injured</div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
