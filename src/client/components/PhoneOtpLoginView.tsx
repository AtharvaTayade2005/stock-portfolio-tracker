import React, { useState } from 'react';
import { ArrowRight, KeyRound, ShieldCheck, Smartphone } from 'lucide-react';

export type AuthRbacRole = 'OWNER_ADMIN' | 'PORTFOLIO_IMPORTER' | 'AUDITOR_READ_ONLY';

export interface AuthSessionState {
  sessionToken: string;
  maskedPhone: string;
  rbacRole: AuthRbacRole;
  upiId: string;
  pbkdf2DigestPrefix: string;
  authenticatedAt: string;
}

interface PhoneOtpLoginViewProps {
  onLoginSuccess: (session: AuthSessionState) => void;
  onSkipToPortfolio: () => void;
}

export const PhoneOtpLoginView: React.FC<PhoneOtpLoginViewProps> = ({
  onLoginSuccess,
  onSkipToPortfolio,
}) => {
  const [phoneNumber, setPhoneNumber] = useState<string>('9820418210');
  const [otpCode, setOtpCode] = useState<string>('482910');
  const [upiId, setUpiId] = useState<string>('atharva@oksbi');
  const [rbacRole, setRbacRole] = useState<AuthRbacRole>('OWNER_ADMIN');
  const [otpNotice, setOtpNotice] = useState<string>('');
  const [errorMsg, setErrorMsg] = useState<string>('');
  const [submitting, setSubmitting] = useState<boolean>(false);

  const handleGenerateOtp = () => {
    const freshOtp = String(Math.floor(100000 + Math.random() * 900000));
    setOtpCode(freshOtp);
    setOtpNotice(`Local 6-digit OTP generated: ${freshOtp} (zero external SMS transmission)`);
    setErrorMsg('');
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setErrorMsg('');
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phoneNumber,
          otpCode,
          rbacRole,
          upiId,
        }),
      });
      const data = (await res.json()) as Partial<AuthSessionState> & {
        authenticated?: boolean;
        error?: string;
      };
      if (!res.ok || !data.authenticated) {
        setErrorMsg(data.error || 'Authentication failed.');
      } else {
        onLoginSuccess({
          sessionToken: data.sessionToken || '',
          maskedPhone: data.maskedPhone || '+91 XXXXX-XXXXX',
          rbacRole: data.rbacRole || rbacRole,
          upiId: data.upiId || upiId,
          pbkdf2DigestPrefix: data.pbkdf2DigestPrefix || 'PBKDF2-SHA256',
          authenticatedAt: data.authenticatedAt || new Date().toISOString(),
        });
      }
    } catch {
      setErrorMsg('Unable to reach local authentication server.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="max-w-md mx-auto my-8 bg-[#0D1421] border border-slate-800 rounded-2xl p-6 shadow-2xl space-y-5 agy-panel-enter">
      <div className="flex items-start justify-between gap-3 border-b border-slate-800 pb-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center shrink-0">
            <ShieldCheck className="w-5 h-5 text-[#00D09C]" />
          </div>
          <div>
            <h2 className="text-base font-semibold text-white">
              3-in-1 Demat & Phone Login
            </h2>
            <p className="text-xs text-slate-400">
              PBKDF2-HMAC-SHA256 local verification for your +91 mobile and OTP.
            </p>
          </div>
        </div>
      </div>

      {otpNotice && (
        <div className="p-2.5 rounded-lg bg-amber-950/35 border border-amber-500/35 text-xs text-amber-200">
          {otpNotice}
        </div>
      )}

      {errorMsg && (
        <div className="p-2.5 rounded-lg bg-rose-950/50 border border-rose-500/40 text-xs text-rose-200">
          {errorMsg}
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-3.5">
        <div>
          <label className="block text-xs font-medium text-slate-300 mb-1">
            Mobile Number (+91 India)
          </label>
          <div className="relative">
            <Smartphone className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="tel"
              value={phoneNumber}
              onChange={(e) => setPhoneNumber(e.target.value)}
              placeholder="9820418210"
              className="w-full pl-9 pr-3 py-2 text-xs font-mono rounded-lg border border-slate-700 bg-[#070B12] text-white focus:outline-none focus:border-emerald-500"
            />
          </div>
        </div>

        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="text-xs font-medium text-slate-300">
              6-Digit 2FA OTP
            </label>
            <button
              type="button"
              onClick={handleGenerateOtp}
              className="text-[11px] font-semibold text-[#00D09C] hover:underline cursor-pointer"
            >
              Generate New OTP
            </button>
          </div>
          <div className="relative">
            <KeyRound className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              maxLength={6}
              value={otpCode}
              onChange={(e) => setOtpCode(e.target.value)}
              placeholder="6-digit OTP"
              className="w-full pl-9 pr-3 py-2 text-xs font-mono rounded-lg border border-slate-700 bg-[#070B12] text-white focus:outline-none focus:border-emerald-500"
            />
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1">
              Linked UPI ID
            </label>
            <input
              type="text"
              value={upiId}
              onChange={(e) => setUpiId(e.target.value)}
              placeholder="name@oksbi"
              className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-slate-700 bg-[#070B12] text-white"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1">
              RBAC Access Role
            </label>
            <select
              value={rbacRole}
              onChange={(e) => setRbacRole(e.target.value as AuthRbacRole)}
              className="w-full px-3 py-2 text-xs rounded-lg border border-slate-700 bg-[#070B12] text-white"
            >
              <option value="OWNER_ADMIN">Owner Admin (Full)</option>
              <option value="PORTFOLIO_IMPORTER">Portfolio Importer</option>
              <option value="AUDITOR_READ_ONLY">Auditor (Read-Only)</option>
            </select>
          </div>
        </div>

        <button
          type="submit"
          disabled={submitting}
          className="w-full py-2.5 rounded-lg text-xs font-semibold bg-[#059669] hover:bg-emerald-500 text-white shadow-md transition cursor-pointer flex items-center justify-center gap-1.5 disabled:opacity-50"
        >
          <span>{submitting ? 'Verifying PBKDF2 Session...' : 'Verify OTP & Sign In'}</span>
          <ArrowRight className="w-3.5 h-3.5" />
        </button>
      </form>

      <div className="pt-3 border-t border-slate-800 flex items-center justify-between text-[11px] text-slate-400">
        <span>Credentials hashed strictly in local memory.</span>
        <button
          type="button"
          onClick={onSkipToPortfolio}
          className="text-slate-300 hover:text-white underline cursor-pointer"
        >
          Continue to Portfolio
        </button>
      </div>
    </div>
  );
};
