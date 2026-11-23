import { useEffect, useState, type FormEvent } from 'react';
import { AlertCircle, Check, CheckCircle2, Copy, RefreshCw } from 'lucide-react';
import { api } from '../lib/api';
import type { EnvironmentStatus, Settings } from '../types';

export function SettingsPage() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [env, setEnv] = useState<EnvironmentStatus | null>(null);
  const [keywordsText, setKeywordsText] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [verifyingFb, setVerifyingFb] = useState(false);
  const [copiedWebhook, setCopiedWebhook] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  async function loadSettings() {
    setLoading(true);
    setFeedback(null);
    try {
      const res = await api.getSettings();
      setSettings(res.settings);
      setEnv(res.environment);
      setKeywordsText(res.settings.humanHandoverKeywords.join(', '));
    } catch (err) {
      setFeedback({
        type: 'error',
        text: err instanceof Error ? err.message : 'Failed to load settings.',
      });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadSettings();
  }, []);

  async function handleSave(e: FormEvent) {
    e.preventDefault();
    if (!settings) return;
    setSaving(true);
    setFeedback(null);

    const keywords = keywordsText
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    try {
      const res = await api.updateSettings({
        businessName: settings.businessName,
        businessDescription: settings.businessDescription,
        currency: settings.currency,
        deliveryCharge: Number(settings.deliveryCharge || 0),
        deliveryChargeNote: settings.deliveryChargeNote,
        returnPolicy: settings.returnPolicy,
        salesInstructions: settings.salesInstructions,
        aiTone: settings.aiTone,
        aiLanguageMode: settings.aiLanguageMode,
        aiGlobalEnabled: settings.aiGlobalEnabled,
        humanHandoverKeywords: keywords,
        humanHandoverRules: settings.humanHandoverRules,
        facebookPageId: settings.facebookPageId,
        facebookPageName: settings.facebookPageName,
      });
      setSettings(res.settings);
      setEnv(res.environment);
      setKeywordsText(res.settings.humanHandoverKeywords.join(', '));
      setFeedback({ type: 'success', text: 'Configuration saved.' });
    } catch (err) {
      setFeedback({
        type: 'error',
        text: err instanceof Error ? err.message : 'Failed to save settings.',
      });
    } finally {
      setSaving(false);
    }
  }

  async function handleVerifyFacebook() {
    setVerifyingFb(true);
    setFeedback(null);
    try {
      const res = await api.verifyFacebookConnection();
      if (res.connected) {
        await loadSettings();
        setFeedback({
          type: 'success',
          text: `Connected to Facebook Page "${res.pageName}" (${res.pageId}).`,
        });
      } else {
        setFeedback({
          type: 'error',
          text: res.error || 'Facebook Page verification failed.',
        });
      }
    } catch (err) {
      setFeedback({
        type: 'error',
        text: err instanceof Error ? err.message : 'Verification request failed.',
      });
    } finally {
      setVerifyingFb(false);
    }
  }

  const webhookUrl = `${(env?.appUrl || window.location.origin).replace(/\/$/, '')}/api/webhooks/messenger`;

  function handleCopyWebhook() {
    void navigator.clipboard?.writeText(webhookUrl);
    setCopiedWebhook(true);
    setTimeout(() => setCopiedWebhook(false), 1800);
  }

  if (loading || !settings) {
    return (
      <div className="space-y-6 max-w-5xl">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-40 bg-white border border-slate-200/90 rounded-xl animate-pulse" />
        ))}
      </div>
    );
  }

  return (
    <form onSubmit={handleSave} className="max-w-5xl space-y-8 pb-8">
      {feedback && (
        <div
          role="status"
          className={`px-4 py-3 text-xs rounded-lg border flex items-center gap-2 ${
            feedback.type === 'success'
              ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
              : 'bg-red-50 text-red-700 border-red-200'
          }`}
        >
          {feedback.type === 'success' ? (
            <CheckCircle2 className="w-4 h-4 shrink-0" />
          ) : (
            <AlertCircle className="w-4 h-4 shrink-0" />
          )}
          <span>{feedback.text}</span>
        </div>
      )}

      {/* Section 1: Facebook Page & Messenger Webhook */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 pb-8 border-b border-slate-200/80">
        <div>
          <h2 className="text-sm font-semibold text-slate-900">Facebook Page & Webhook</h2>
          <p className="text-xs text-slate-500 mt-1 leading-relaxed">
            Connect one Facebook Page via Meta Graph API. Tokens remain in server environment variables.
          </p>
        </div>

        <div className="lg:col-span-2 bg-white border border-slate-200/90 rounded-xl p-6 space-y-5 shadow-[0_1px_2px_rgba(15,23,42,0.03)]">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="text-xs font-medium text-slate-700">Messenger Webhook Endpoint</span>
            <button
              type="button"
              disabled={verifyingFb}
              onClick={() => void handleVerifyFacebook()}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 border border-slate-300 hover:bg-slate-50 rounded-lg transition-colors cursor-pointer"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${verifyingFb ? 'animate-spin' : ''}`} />
              <span>{verifyingFb ? 'Verifying...' : 'Verify Page Connection'}</span>
            </button>
          </div>

          <div className="flex items-center gap-2">
            <input
              type="text"
              readOnly
              value={webhookUrl}
              className="flex-1 px-3 py-2 text-xs font-mono bg-slate-50 border border-slate-200 rounded-lg text-slate-700"
            />
            <button
              type="button"
              onClick={handleCopyWebhook}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-700 border border-slate-300 hover:bg-slate-50 rounded-lg cursor-pointer shrink-0"
            >
              {copiedWebhook ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
              <span>{copiedWebhook ? 'Copied' : 'Copy'}</span>
            </button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1.5">Facebook Page ID</label>
              <input
                type="text"
                value={settings.facebookPageId}
                onChange={(e) => setSettings({ ...settings, facebookPageId: e.target.value })}
                placeholder="e.g. 10428592104821"
                className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600/20 focus:border-blue-600"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1.5">Facebook Page Name</label>
              <input
                type="text"
                value={settings.facebookPageName}
                onChange={(e) => setSettings({ ...settings, facebookPageName: e.target.value })}
                placeholder="Populated on verification"
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600/20 focus:border-blue-600"
              />
            </div>
          </div>

          {env && (
            <div className="pt-4 border-t border-slate-200/80 grid grid-cols-1 sm:grid-cols-2 gap-y-2 gap-x-6 text-xs">
              <div className="flex items-center justify-between py-1">
                <span className="text-slate-500">Database</span>
                <span className={env.databaseMode === 'mongodb' ? 'text-emerald-700 font-medium' : 'text-amber-700 font-medium'}>
                  {env.databaseMode === 'mongodb' ? 'MongoDB connected' : 'Preview store'}
                </span>
              </div>
              <div className="flex items-center justify-between py-1">
                <span className="text-slate-500 font-mono">GEMINI_API_KEY</span>
                <span className={env.geminiConfigured ? 'text-emerald-700 font-medium' : 'text-red-700 font-medium'}>
                  {env.geminiConfigured ? 'Configured' : 'Missing'}
                </span>
              </div>
              <div className="flex items-center justify-between py-1">
                <span className="text-slate-500 font-mono">META_PAGE_ACCESS_TOKEN</span>
                <span className={env.metaPageTokenConfigured ? 'text-emerald-700 font-medium' : 'text-amber-700 font-medium'}>
                  {env.metaPageTokenConfigured ? 'Configured' : 'Not set'}
                </span>
              </div>
              <div className="flex items-center justify-between py-1">
                <span className="text-slate-500 font-mono">META_APP_SECRET & VERIFY_TOKEN</span>
                <span
                  className={
                    env.metaAppSecretConfigured && env.metaVerifyTokenConfigured
                      ? 'text-emerald-700 font-medium'
                      : 'text-amber-700 font-medium'
                  }
                >
                  {env.metaAppSecretConfigured && env.metaVerifyTokenConfigured ? 'Configured' : 'Incomplete'}
                </span>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Section 2: Business Profile & Policies */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 pb-8 border-b border-slate-200/80">
        <div>
          <h2 className="text-sm font-semibold text-slate-900">Business Profile & Policies</h2>
          <p className="text-xs text-slate-500 mt-1 leading-relaxed">
            Authoritative store name, currency, delivery charge, and return rules used during order confirmation.
          </p>
        </div>

        <div className="lg:col-span-2 bg-white border border-slate-200/90 rounded-xl p-6 space-y-4 shadow-[0_1px_2px_rgba(15,23,42,0.03)]">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="sm:col-span-2">
              <label className="block text-xs font-medium text-slate-700 mb-1.5">Business Name</label>
              <input
                type="text"
                required
                value={settings.businessName}
                onChange={(e) => setSettings({ ...settings, businessName: e.target.value })}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600/20 focus:border-blue-600"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1.5">Currency</label>
              <input
                type="text"
                required
                value={settings.currency}
                onChange={(e) => setSettings({ ...settings, currency: e.target.value })}
                placeholder="BDT"
                className="w-full px-3 py-2 text-sm font-mono uppercase border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600/20 focus:border-blue-600"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1.5">Business Description</label>
            <textarea
              rows={2}
              value={settings.businessDescription}
              onChange={(e) => setSettings({ ...settings, businessDescription: e.target.value })}
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600/20 focus:border-blue-600"
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1.5">
                Delivery Charge ({settings.currency})
              </label>
              <input
                type="number"
                min="0"
                step="0.01"
                value={settings.deliveryCharge}
                onChange={(e) => setSettings({ ...settings, deliveryCharge: Number(e.target.value) })}
                className="w-full px-3 py-2 text-sm font-mono tabular-nums border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600/20 focus:border-blue-600"
              />
            </div>
            <div className="sm:col-span-2">
              <label className="block text-xs font-medium text-slate-700 mb-1.5">Delivery Details</label>
              <input
                type="text"
                value={settings.deliveryChargeNote}
                onChange={(e) => setSettings({ ...settings, deliveryChargeNote: e.target.value })}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600/20 focus:border-blue-600"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1.5">Return & Refund Policy</label>
            <textarea
              rows={2}
              value={settings.returnPolicy}
              onChange={(e) => setSettings({ ...settings, returnPolicy: e.target.value })}
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600/20 focus:border-blue-600"
            />
          </div>
        </div>
      </div>

      {/* Section 3: AI Behavior & Human Handover */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div>
          <h2 className="text-sm font-semibold text-slate-900">AI Sales Agent & Handover</h2>
          <p className="text-xs text-slate-500 mt-1 leading-relaxed">
            Control language behavior, reply length, sales instructions, and automatic escalation to human staff.
          </p>
        </div>

        <div className="lg:col-span-2 bg-white border border-slate-200/90 rounded-xl p-6 space-y-5 shadow-[0_1px_2px_rgba(15,23,42,0.03)]">
          <div className="flex items-center justify-between gap-4 pb-4 border-b border-slate-200/80">
            <div>
              <p className="text-xs font-medium text-slate-900">Global AI Auto-Reply</p>
              <p className="text-xs text-slate-500 mt-0.5">
                When paused, incoming messages are stored without automatic replies.
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={settings.aiGlobalEnabled}
              onClick={() => setSettings({ ...settings, aiGlobalEnabled: !settings.aiGlobalEnabled })}
              className={`relative inline-flex h-6 w-11 shrink-0 rounded-full border-2 border-transparent transition-colors cursor-pointer ${
                settings.aiGlobalEnabled ? 'bg-blue-600' : 'bg-slate-200'
              }`}
            >
              <span
                className={`pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow-xs transition-transform ${
                  settings.aiGlobalEnabled ? 'translate-x-5' : 'translate-x-0'
                }`}
              />
            </button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1.5">Response Tone</label>
              <select
                value={settings.aiTone}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    aiTone: e.target.value as Settings['aiTone'],
                  })
                }
                className="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600/20 focus:border-blue-600"
              >
                <option value="concise_direct">Concise & Short</option>
                <option value="warm_professional">Warm & Professional</option>
                <option value="consultative">Consultative Advisor</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1.5">Language Behavior</label>
              <select
                value={settings.aiLanguageMode}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    aiLanguageMode: e.target.value as Settings['aiLanguageMode'],
                  })
                }
                className="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600/20 focus:border-blue-600"
              >
                <option value="bangla">Always Bangla</option>
                <option value="auto_multilingual">Auto (Bangla, English & Banglish)</option>
                <option value="english">Always English</option>
              </select>
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1.5">Sales Instructions</label>
            <textarea
              rows={3}
              value={settings.salesInstructions}
              onChange={(e) => setSettings({ ...settings, salesInstructions: e.target.value })}
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600/20 focus:border-blue-600"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1.5">
              Human Handover Trigger Keywords (comma-separated)
            </label>
            <input
              type="text"
              value={keywordsText}
              onChange={(e) => setKeywordsText(e.target.value)}
              placeholder="human, agent, manager, complaint, refund"
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600/20 focus:border-blue-600"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1.5">Human Handover Rules</label>
            <textarea
              rows={2}
              value={settings.humanHandoverRules}
              onChange={(e) => setSettings({ ...settings, humanHandoverRules: e.target.value })}
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600/20 focus:border-blue-600"
            />
          </div>

          <div className="pt-3 border-t border-slate-200/80 flex justify-end">
            <button
              type="submit"
              disabled={saving}
              className="px-5 py-2 text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-60 rounded-lg shadow-[0_1px_2px_rgba(37,99,235,0.25)] transition-colors cursor-pointer"
            >
              {saving ? 'Saving...' : 'Save Configuration'}
            </button>
          </div>
        </div>
      </div>
    </form>
  );
}
