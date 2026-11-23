import { useState, type FormEvent } from 'react';
import { Eye, EyeOff, MessageSquare } from 'lucide-react';
import { api } from '../lib/api';
import type { AdminUser, AuthBootstrapStatus } from '../types';

interface AuthGateProps {
  status: AuthBootstrapStatus;
  onAuthenticated: (admin: AdminUser) => void;
}

export function AuthGate({ status, onAuthenticated }: AuthGateProps) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState(status.envEmailHint || '');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const isSetup = status.needsSetup && !status.envPasscodeConfigured;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res = isSetup
        ? await api.claimAdmin({ email: email.trim(), name: name.trim(), password })
        : await api.login({ email: email.trim() || undefined, password });
      onAuthenticated(res.admin);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Authentication failed.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen bg-[#f8fafc] flex flex-col items-center justify-center px-4 py-12">
      <div className="w-full max-w-[380px]">
        <div className="flex items-center justify-center gap-2.5 mb-8">
          <div className="w-8 h-8 rounded-lg bg-blue-600 text-white flex items-center justify-center shadow-[0_1px_2px_rgba(37,99,235,0.3)]">
            <MessageSquare className="w-4 h-4" />
          </div>
          <span className="font-display text-lg font-semibold text-slate-900">PageFlow AI</span>
        </div>

        <div className="bg-white border border-slate-200/90 rounded-xl p-7 shadow-[0_1px_3px_rgba(15,23,42,0.04)]">
          <div className="mb-6">
            <h1 className="font-display text-lg font-semibold text-slate-900">
              {isSetup ? 'Create administrator account' : 'Sign in to your workspace'}
            </h1>
            <p className="text-[13px] text-slate-500 mt-1">
              {isSetup
                ? 'Set up the primary admin account to manage your Facebook Page.'
                : 'Enter your credentials to manage Messenger sales and orders.'}
            </p>
          </div>

          {error && (
            <div
              role="alert"
              className="mb-5 px-3.5 py-2.5 text-xs text-red-700 bg-red-50/80 border border-red-200 rounded-lg"
            >
              {error}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            {isSetup && (
              <div>
                <label htmlFor="admin-name" className="block text-xs font-medium text-slate-700 mb-1.5">
                  Full Name
                </label>
                <input
                  id="admin-name"
                  type="text"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Store Manager"
                  className="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg text-slate-900 placeholder:text-slate-400 transition-colors focus:outline-none focus:ring-2 focus:ring-blue-600/20 focus:border-blue-600"
                />
              </div>
            )}

            <div>
              <label htmlFor="admin-email" className="block text-xs font-medium text-slate-700 mb-1.5">
                Email Address
              </label>
              <input
                id="admin-email"
                type="email"
                required={!status.envPasscodeConfigured}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="admin@company.com"
                className="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg text-slate-900 placeholder:text-slate-400 transition-colors focus:outline-none focus:ring-2 focus:ring-blue-600/20 focus:border-blue-600"
              />
            </div>

            <div>
              <label htmlFor="admin-password" className="block text-xs font-medium text-slate-700 mb-1.5">
                Password
              </label>
              <div className="relative">
                <input
                  id="admin-password"
                  type={showPassword ? 'text' : 'password'}
                  required
                  minLength={isSetup ? 8 : 1}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={isSetup ? 'Minimum 8 characters' : 'Enter your password'}
                  className="w-full pl-3 pr-9 py-2 text-sm bg-white border border-slate-300 rounded-lg text-slate-900 placeholder:text-slate-400 transition-colors focus:outline-none focus:ring-2 focus:ring-blue-600/20 focus:border-blue-600"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 text-slate-400 hover:text-slate-600 cursor-pointer"
                >
                  {showPassword ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                </button>
              </div>
            </div>

            <button
              type="submit"
              disabled={submitting}
              className="w-full mt-2 py-2.5 px-4 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-60 rounded-lg shadow-[0_1px_2px_rgba(37,99,235,0.25)] transition-colors cursor-pointer"
            >
              {submitting
                ? isSetup
                  ? 'Creating account...'
                  : 'Signing in...'
                : isSetup
                  ? 'Create Admin Account'
                  : 'Sign In'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
