import { useEffect, useRef, useState, type KeyboardEvent } from 'react';

/** The browser's shape-detection API (Chrome/Android, Safari 17+). Not in TypeScript's DOM lib everywhere, so typed here. */
interface Detector { detect(source: HTMLVideoElement): Promise<{ rawValue: string }[]> }
type DetectorCtor = new () => Detector;

const detectorCtor = (): DetectorCtor | undefined => (window as unknown as { BarcodeDetector?: DetectorCtor }).BarcodeDetector;
const COOLDOWN_MS = 1500;
const POLL_MS = 250;

/**
 * Barcode input. Always works with a USB/Bluetooth scanner (they type the code and press Enter) or by typing;
 * adds a camera button where the browser can detect barcodes itself. Every scan is reported once, trimmed.
 */
export function Scanner({ onScan, label = 'Scan or type a barcode' }: { onScan: (code: string) => void; label?: string }) {
  const [value, setValue] = useState('');
  const [cameraOn, setCameraOn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const onScanRef = useRef(onScan);
  onScanRef.current = onScan;
  const cameraAvailable = typeof window !== 'undefined' && detectorCtor() !== undefined && Boolean(navigator.mediaDevices?.getUserMedia);

  const submit = () => {
    const code = value.trim();
    if (!code) return;
    setValue('');
    onScan(code);
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } };

  useEffect(() => {
    if (!cameraOn) return;
    let stopped = false;
    let stream: MediaStream | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    const last = { code: '', at: 0 };
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
        if (stopped) { stream.getTracks().forEach((t) => t.stop()); return; }
        const video = videoRef.current;
        if (video) { video.srcObject = stream; await video.play().catch(() => undefined); }
        const Detector = detectorCtor()!;
        const detector = new Detector();
        timer = setInterval(() => {
          if (!videoRef.current) return;
          detector.detect(videoRef.current).then((found) => {
            const code = found[0]?.rawValue?.trim();
            if (!code || stopped) return;
            const now = Date.now();
            if (code === last.code && now - last.at < COOLDOWN_MS) return; // the same label still in view
            last.code = code; last.at = now;
            onScanRef.current(code);
          }).catch(() => undefined); // a frame that cannot be read is simply skipped
        }, POLL_MS);
      } catch {
        if (!stopped) { setError('The camera could not be opened. Allow camera access in your browser, or type the code instead.'); setCameraOn(false); }
      }
    })();
    return () => { stopped = true; if (timer) clearInterval(timer); stream?.getTracks().forEach((t) => t.stop()); };
  }, [cameraOn]);

  return (
    <div className="grid" style={{ gap: 6 }}>
      <div className="row">
        <input aria-label={label} value={value} onChange={(e) => setValue(e.target.value)} onKeyDown={onKey}
          autoComplete="off" inputMode="text" placeholder="Scan or type, then Enter" style={{ flex: 1 }} />
        <button type="button" onClick={submit} disabled={!value.trim()}>Add</button>
        {cameraAvailable && (cameraOn
          ? <button type="button" onClick={() => setCameraOn(false)}>Stop camera</button>
          : <button type="button" onClick={() => { setError(null); setCameraOn(true); }}>Scan with camera</button>)}
      </div>
      {!cameraAvailable && <p className="small muted">Use a USB or Bluetooth scanner, or type the code and press Enter.</p>}
      {error && <div className="banner error" role="alert">{error}</div>}
      {cameraOn && <video ref={videoRef} playsInline muted aria-label="Camera preview" style={{ width: '100%', maxWidth: 360, borderRadius: 8 }} />}
    </div>
  );
}
