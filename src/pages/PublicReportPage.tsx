import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle, ArrowRight, CheckCircle2, ChevronDown, Copy, LocateFixed, Loader2, MapPin, Send, X,
} from 'lucide-react';
import { VoiceInput } from '../components/intake/VoiceInput';
import { PublicShell } from '../components/layout/PublicShell';
import { Button, Callout } from '../components/ui/primitives';
import { cx } from '../utils/cx';
import { ApiError, uuid } from '../lib/http';
import { postPublicReport, type ReportResult } from '../lib/data';
import { publicPlaceName, shortId } from '../utils/helpers';

const SAMPLE_MESSAGES = [
  { lang: 'English', text: 'Major fire broke out near the railway line in Dharavi. About 20 shanties burning. Children are trapped on upper floors. Need fire trucks urgently!' },
  { lang: 'हिंदी', text: 'सायन-माटुंगा रोड पर बाढ़ का पानी भर गया है। गाड़ियां फंसी हुई हैं। कम से कम 15 लोग फंसे हैं।' },
  { lang: 'मराठी', text: 'भेंडी बाजार जवळ इमारत कोसळली. ३० लोक अडकले आहेत. तातडीने मदत पाठवा!' },
];

type Gps = { lat: number; lng: number; accuracy: number };

/** Citizen emergency report: location first, then what happened, then send. No account needed. */
export function PublicReportPage() {
  const [message, setMessage] = useState('');
  const [place, setPlace] = useState('');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [showDetails, setShowDetails] = useState(false);
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState<ReportResult | null>(null);
  const [needsLocation, setNeedsLocation] = useState('');
  const [error, setError] = useState('');
  const [gps, setGps] = useState<Gps | null>(null);
  const [gpsError, setGpsError] = useState('');
  const [gpsLoading, setGpsLoading] = useState(false);
  // One id per report attempt, so a retry after a network error is not counted twice.
  const clientId = useRef(uuid());

  const locate = () => {
    if (!navigator.geolocation) {
      setGpsError('This browser cannot share your location. Type the place instead.');
      return;
    }
    setGpsLoading(true);
    setGpsError('');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setGps({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy });
        setGpsLoading(false);
        setNeedsLocation('');
      },
      (err) => {
        setGpsError(err.code === 1 ? 'Location permission was denied. Type the place instead, or allow location in your browser settings.' : 'Could not get your location. Type the place instead.');
        setGpsLoading(false);
      },
      { enableHighAccuracy: true, timeout: 15000 },
    );
  };

  const hasLocation = !!gps || place.trim().length > 0;

  const submit = async () => {
    if (!message.trim()) return;
    setLoading(true);
    setError('');
    setNeedsLocation('');
    const text = place.trim() ? `${message.trim()}\nLocation: ${place.trim()}` : message.trim();
    try {
      const result = await postPublicReport({
        raw_message: text,
        source: 'public_web',
        reporter_name: name.trim() || undefined,
        reporter_phone: phone.trim() || undefined,
        reporter_lat: gps?.lat,
        reporter_lng: gps?.lng,
        reporter_accuracy: gps ? Math.round(gps.accuracy) : undefined,
        client_id: clientId.current,
        reported_at: new Date().toISOString(),
      });
      setSent(result);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'location_required') {
        setNeedsLocation(e.message);
        // The server rejected it without storing, so the next attempt is a new report.
        clientId.current = uuid();
      } else {
        setError(e instanceof ApiError && e.offline ? 'Cannot reach the server. Check your connection and try again.' : (e as Error).message);
      }
    } finally {
      setLoading(false);
    }
  };

  const reset = () => {
    setSent(null);
    setMessage('');
    setPlace('');
    setGps(null);
    clientId.current = uuid();
  };

  if (sent) return <ReportSent result={sent} onAnother={reset} />;

  return (
    <PublicShell context="Emergency report" footer={<>No account needed. If a life is in danger, also call <b className="text-text-muted">112</b>.</>}>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Report an emergency</h1>
        <p className="text-sm text-text-muted mt-1">Tell us where and what is happening. You can write in any language.</p>
      </div>

      <section className={cx('rounded-xl border p-4 space-y-3', needsLocation ? 'border-warning/60 bg-warning/[0.05]' : 'border-border bg-bg-card')} aria-labelledby="where">
        <h2 id="where" className="text-sm font-semibold flex items-center gap-2"><MapPin className="w-4 h-4 text-accent" /> Where is the emergency?</h2>
        {gps ? (
          <div className="flex items-center gap-2 p-3 rounded-lg border border-success/40 bg-success/10">
            <CheckCircle2 className="w-5 h-5 text-success flex-shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium text-green-200">Your location is attached</div>
              <div className="text-xs text-text-muted">Accurate to about {gps.accuracy < 1000 ? `${Math.round(gps.accuracy)} m` : `${(gps.accuracy / 1000).toFixed(1)} km`}{gps.accuracy > 300 ? ' — add a landmark below to help responders' : ''}</div>
            </div>
            <button type="button" onClick={() => setGps(null)} className="p-2 rounded-lg hover:bg-bg-card-hover cursor-pointer" aria-label="Remove location"><X className="w-4 h-4 text-text-dim" /></button>
          </div>
        ) : (
          <Button variant="secondary" size="lg" className="w-full border-accent/60 text-blue-200" busy={gpsLoading} icon={<LocateFixed className="w-5 h-5" />} onClick={locate}>
            {gpsLoading ? 'Finding your location…' : 'Attach my current location'}
          </Button>
        )}
        {gpsError && <p className="text-xs text-warning">{gpsError}</p>}
        <div>
          <label htmlFor="place" className="text-xs text-text-muted">{gps ? 'Nearest building or landmark (optional)' : 'Or type the building, street or landmark'}</label>
          <input
            id="place"
            value={place}
            onChange={(e) => { setPlace(e.target.value); if (e.target.value.trim()) setNeedsLocation(''); }}
            placeholder="e.g. Sion railway station, west exit"
            maxLength={200}
            className="mt-1 w-full bg-bg-inset border border-border rounded-lg px-3 py-3 text-base text-text placeholder-text-dim focus:outline-none focus:border-accent"
          />
        </div>
        {needsLocation && (
          <Callout tone="warning" title="We need a more exact location">
            {needsLocation} Your message is kept.
          </Callout>
        )}
      </section>

      <section className="rounded-xl border border-border bg-bg-card p-4 space-y-3" aria-labelledby="what">
        <h2 id="what" className="text-sm font-semibold">What is happening?</h2>
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="What happened, how many people are affected, is anyone hurt or trapped…"
          aria-labelledby="what"
          className="w-full h-32 bg-bg-inset border border-border rounded-lg px-3 py-2.5 text-base text-text placeholder-text-dim focus:outline-none focus:border-accent resize-none"
          maxLength={5000}
        />
        <div className="flex items-center gap-2 flex-wrap">
          <VoiceInput
            disabled={loading}
            label="Speak instead of typing"
            className="px-3 py-2.5 text-sm"
            onTranscript={(t) => setMessage((m) => (m.trim() ? `${m.trim()} ${t}` : t))}
          />
        </div>
        <div className="flex gap-1.5 flex-wrap items-center">
          <span className="text-[11px] text-text-dim mr-0.5">Try a sample:</span>
          {SAMPLE_MESSAGES.map((s) => (
            <button key={s.lang} type="button" onClick={() => setMessage(s.text)} className="px-2.5 py-1.5 text-xs rounded-full border border-border text-text-muted hover:text-text hover:border-accent cursor-pointer">
              {s.lang}
            </button>
          ))}
        </div>
      </section>

      <section className="rounded-xl border border-border bg-bg-card">
        <button type="button" onClick={() => setShowDetails((s) => !s)} aria-expanded={showDetails} className="w-full flex items-center gap-2 px-4 py-3 text-sm text-text-muted cursor-pointer">
          Your contact details (optional)
          <ChevronDown className={cx('w-4 h-4 ml-auto transition-transform', showDetails && 'rotate-180')} />
        </button>
        {showDetails && (
          <div className="px-4 pb-4 grid grid-cols-1 sm:grid-cols-2 gap-2">
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" aria-label="Your name" maxLength={100}
              className="bg-bg-inset border border-border rounded-lg px-3 py-2.5 text-base sm:text-sm focus:outline-none focus:border-accent" />
            <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="Phone number" aria-label="Phone number" inputMode="tel" maxLength={30}
              className="bg-bg-inset border border-border rounded-lg px-3 py-2.5 text-base sm:text-sm focus:outline-none focus:border-accent" />
            <p className="sm:col-span-2 text-[11px] text-text-dim">Only emergency coordinators see these, in case they need to call you back.</p>
          </div>
        )}
      </section>

      {error && <Callout tone="danger">{error}</Callout>}

      <div className="space-y-2">
        <Button variant="primary" size="lg" className="w-full" busy={loading} disabled={!message.trim()} icon={<Send className="w-5 h-5" />} onClick={submit}>
          {loading ? 'Sending report…' : 'Send emergency report'}
        </Button>
        {!message.trim() ? (
          <p className="text-center text-xs text-text-dim">Describe what is happening to send the report.</p>
        ) : !hasLocation && (
          <p className="text-center text-xs text-warning flex items-center justify-center gap-1"><AlertTriangle className="w-3.5 h-3.5" /> Add your location or a landmark so responders know where to go.</p>
        )}
      </div>
    </PublicShell>
  );
}

function ReportSent({ result, onAnother }: { result: ReportResult; onAnother: () => void }) {
  const [copied, setCopied] = useState(false);
  const incident = result.incident;
  const trackPath = incident ? `/track/${incident.id}` : null;

  const copy = async () => {
    if (!trackPath) return;
    try {
      await navigator.clipboard.writeText(`${window.location.origin}${trackPath}`);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard blocked; the link is still shown below
    }
  };

  return (
    <PublicShell context="Report received" footer={<>If a life is in danger, also call <b className="text-text-muted">112</b>.</>}>
      <div className="rounded-xl border border-border bg-bg-card p-6 text-center space-y-4">
        <span className="mx-auto w-14 h-14 rounded-full bg-success/15 border border-success/40 flex items-center justify-center">
          <CheckCircle2 className="w-8 h-8 text-success" />
        </span>
        <div>
          <h1 className="text-xl font-semibold">Emergency report received</h1>
          <p className="text-sm text-text-muted mt-1">
            {result.is_duplicate
              ? 'Others have reported this emergency too. Your report has been added to it and helps responders.'
              : 'Your report has been sent to the emergency control room.'}
          </p>
        </div>
        {incident && (
          <div className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-bg-inset border border-border">
            <span className="text-xs text-text-dim">Tracking ID</span>
            <span className="font-mono font-semibold tracking-wider">{shortId(incident.id)}</span>
            <button type="button" onClick={copy} className="p-1 rounded hover:bg-bg-card-hover cursor-pointer" aria-label="Copy tracking link">
              {copied ? <CheckCircle2 className="w-4 h-4 text-success" /> : <Copy className="w-4 h-4 text-text-dim" />}
            </button>
          </div>
        )}
      </div>

      <div className="rounded-xl border border-border bg-bg-card p-4 space-y-3">
        <h2 className="text-sm font-semibold">What happens next</h2>
        <ol className="space-y-2.5 text-sm text-text-muted">
          <li className="flex gap-3"><Step n={1} /> A coordinator reviews your report.</li>
          <li className="flex gap-3"><Step n={2} /> The right response team is sent{publicPlaceName(incident?.location_name) ? ` to ${publicPlaceName(incident?.location_name)}` : ''}.</li>
          <li className="flex gap-3"><Step n={3} /> You can follow progress live on the tracking page.</li>
        </ol>
      </div>

      {trackPath ? (
        <Link to={trackPath} className="w-full inline-flex items-center justify-center gap-2 px-5 py-3 min-h-12 rounded-xl bg-accent hover:bg-accent-hover text-white font-semibold">
          Track this report <ArrowRight className="w-5 h-5" />
        </Link>
      ) : (
        <p className="text-center text-sm text-text-muted"><Loader2 className="w-4 h-4 inline animate-spin" /> Your report is logged.</p>
      )}
      <button type="button" onClick={onAnother} className="w-full text-center text-sm text-text-muted hover:text-text py-2 cursor-pointer">Report another emergency</button>
    </PublicShell>
  );
}

function Step({ n }: { n: number }) {
  return <span className="w-6 h-6 flex-shrink-0 rounded-full bg-accent/15 text-blue-300 text-xs font-semibold flex items-center justify-center">{n}</span>;
}
