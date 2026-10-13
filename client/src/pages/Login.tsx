import QRCode from 'qrcode';
import { useEffect, useState, type FormEvent } from 'react';
import type { LoginResponse } from '../../../server/src/api-types.ts';
import { api } from '../api.ts';
import { ErrorNote } from '../components/ui.tsx';

export function Login({ enrolled, onSignedIn }: { enrolled: boolean; onSignedIn: () => void }) {
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [enroll, setEnroll] = useState<LoginResponse['enroll'] | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (enroll) QRCode.toDataURL(enroll.uri, { margin: 0, width: 168 }).then(setQr);
  }, [enroll]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api<LoginResponse>('/auth/login', { body: { password, code: code || undefined } });
      if (res.enroll) setEnroll(res.enroll);
      else onSignedIn();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const askCode = enrolled || Boolean(enroll);
  return (
    <div className="signin">
      <form className="panel panel-body stack" onSubmit={submit}>
        <h1>Workshop</h1>
        {enroll ? (
          <>
            <p>Scan this with an authenticator app, then enter the 6-digit code it shows. You'll need a code every time you sign in.</p>
            {qr && <img className="qr" src={qr} alt="QR code to add Workshop to your authenticator app" />}
            <p className="small muted">
              Can't scan it? Enter this key instead: <code>{enroll.secret}</code>
            </p>
          </>
        ) : (
          !enrolled && <p className="muted">First sign-in: after your password, you'll add Workshop to an authenticator app.</p>
        )}
        <label className="field">
          <span>Password</span>
          <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus required />
        </label>
        {askCode && (
          <label className="field">
            <span>Code from your authenticator app</span>
            <input
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              required
            />
          </label>
        )}
        <ErrorNote error={error} />
        <button className="primary" disabled={busy}>
          {enroll ? 'Finish setup' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
