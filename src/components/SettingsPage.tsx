import { useEffect, useState, type FormEvent } from 'react';
import {
  AlertCircle,
  Check,
  CheckCircle2,
  Copy,
  Eye,
  EyeOff,
  KeyRound,
  Plus,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import { api } from '../lib/api';
import type { EnvironmentStatus, GeminiApiKeySummary, Settings } from '../types';

function formatKeyStatus(item: GeminiApiKeySummary): { text: string; className: string } {
  if (!item.isActive || item.status === 'disabled') {
    return { text: 'Disabled', className: 'text-slate-400' };
  }
  if (item.status === 'invalid') {
    return { text: 'Invalid key', className: 'text-red-600 font-medium' };
  }
  if (item.status === 'rate_limited') {
    let suffix = '';
    if (item.cooldownUntil) {
      const secs = Math.max(0, Math.ceil((new Date(item.cooldownUntil).getTime() - Date.now()) / 1000));
      if (secs > 0) suffix = ` (${secs}s cooldown)`;
    }
    return { text: `Rate limited${suffix}`, className: 'text-amber-700 font-medium' };
  }
  if (item.isCurrent) {
    return { text: 'Current · Active', className: 'text-emerald-700 font-semibold' };
  }
  return { text: 'Standby · Ready', className: 'text-slate-600' };
}

export function SettingsPage() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [env, setEnv] = useState<EnvironmentStatus | null>(null);
  const [geminiKeys, setGeminiKeys] = useState<GeminiApiKeySummary[]>([]);
  const [keywordsText, setKeywordsText] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [verifyingFb, setVerifyingFb] = useState(false);
  const [copiedWebhook, setCopiedWebhook] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Add Gemini API Key state
  const [newKeyLabel, setNewKeyLabel] = useState('');
  const [newKeyValue, setNewKeyValue] = useState('');
  const [showKeyValue, setShowKeyValue] = useState(false);
  const [makePrimaryOnAdd, setMakePrimaryOnAdd] = useState(true);
  const [addingKey, setAddingKey] = useState(false);
  const [busyKeyId, setBusyKeyId] = useState<string | null>(null);

  async function loadSettings() {
    setLoading(true);
    setFeedback(null);
    try {
      const res = await api.getSettings();
      setSettings(res.settings);
      setEnv(res.environment);
      setGeminiKeys(res.geminiKeys?.keys ?? []);
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

  async function handleAddGeminiKey() {
    const cleanKey = newKeyValue.trim();
    if (!cleanKey) {
      setFeedback({ type: 'error', text: 'Please enter a Gemini API key.' });
      return;
    }
    setAddingKey(true);
    setFeedback(null);
    try {
      const res = await api.addGeminiKey({
        apiKey: cleanKey,
        label: newKeyLabel.trim() || undefined,
        makePrimary: makePrimaryOnAdd,
      });
      setGeminiKeys(res.keys);
      setEnv(res.environment);
      setNewKeyLabel('');
      setNewKeyValue('');
      setShowKeyValue(false);
      setFeedback({ type: 'success', text: `Added Gemini key "${res.key.label}".` });
    } catch (err) {
      setFeedback({
        type: 'error',
        text: err instanceof Error ? err.message : 'Failed to add Gemini API key.',
      });
    } finally {
      setAddingKey(false);
    }
  }

  async function handleUpdateGeminiKey(
    id: string,
    patch: { isActive?: boolean; makePrimary?: boolean; resetStatus?: boolean },
  ) {
    setBusyKeyId(id);
    setFeedback(null);
    try {
      const res = await api.updateGeminiKey(id, patch);
      setGeminiKeys(res.keys);
      setEnv(res.environment);
    } catch (err) {
      setFeedback({
        type: 'error',
        text: err instanceof Error ? err.message : 'Failed to update API key.',
      });
    } finally {
      setBusyKeyId(null);
    }
  }

  async function handleTestGeminiKey(id: string) {
    setBusyKeyId(id);
    setFeedback(null);
    try {
      const res = await api.testGeminiKey(id);
      setGeminiKeys(res.keys);
      setEnv(res.environment);
      setFeedback({
        type: res.ok ? 'success' : 'error',
        text: res.message,
      });
    } catch (err) {
      setFeedback({
        type: 'error',
        text: err instanceof Error ? err.message : 'Key verification failed.',
      });
    } finally {
      setBusyKeyId(null);
    }
  }

  async function handleDeleteGeminiKey(id: string) {
    setBusyKeyId(id);
    setFeedback(null);
    try {
      const res = await api.deleteGeminiKey(id);
      setGeminiKeys(res.keys);
      setEnv(res.environment);
      setFeedback({ type: 'success', text: 'API key removed.' });
    } catch (err) {
      setFeedback({
        type: 'error',
        text: err instanceof Error ? err.message : 'Failed to delete API key.',
      });
    } finally {
      setBusyKeyId(null);
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
    <div className="max-w-5xl space-y-8 pb-8">
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

      {/* Section 0: Gemini API Keys & Automatic Rate-Limit Shift */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 pb-8 border-b border-slate-200/80">
        <div>
          <h2 className="text-sm font-semibold text-slate-900">Gemini API Keys & Auto-Shift</h2>
          <p className="text-xs text-slate-500 mt-1 leading-relaxed">
            Add multiple Gemini API keys directly here without touching <span className="font-mono">.env</span>.
            The agent uses the active key until it hits a rate limit, then shifts to the next available key.
          </p>
        </div>

        <div className="lg:col-span-2 bg-white border border-slate-200/90 rounded-xl p-6 space-y-5 shadow-[0_1px_2px_rgba(15,23,42,0.03)]">
          {/* Add key controls */}
          <div className="space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-12 gap-3">
              <div className="sm:col-span-4">
                <label className="block text-xs font-medium text-slate-700 mb-1.5">
                  Key Label (optional)
                </label>
                <input
                  type="text"
                  value={newKeyLabel}
                  onChange={(e) => setNewKeyLabel(e.target.value)}
                  placeholder="e.g. Primary Key"
                  className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600/20 focus:border-blue-600"
                />
              </div>
              <div className="sm:col-span-8">
                <label className="block text-xs font-medium text-slate-700 mb-1.5">
                  Gemini API Key
                </label>
                <div className="flex items-center gap-2">
                  <div className="relative flex-1">
                    <input
                      type={showKeyValue ? 'text' : 'password'}
                      value={newKeyValue}
                      onChange={(e) => setNewKeyValue(e.target.value)}
                      placeholder="AIzaSy..."
                      autoComplete="off"
                      className="w-full pl-3 pr-9 py-2 text-xs font-mono border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600/20 focus:border-blue-600"
                    />
                    <button
                      type="button"
                      onClick={() => setShowKeyValue((v) => !v)}
                      aria-label={showKeyValue ? 'Hide key' : 'Show key'}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700 cursor-pointer"
                    >
                      {showKeyValue ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                    </button>
                  </div>
                  <button
                    type="button"
                    disabled={addingKey}
                    onClick={() => void handleAddGeminiKey()}
                    className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-60 rounded-lg cursor-pointer shrink-0"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    {addingKey ? 'Adding...' : 'Add Key'}
                  </button>
                </div>
              </div>
            </div>

            <label className="inline-flex items-center gap-2 text-xs text-slate-600 cursor-pointer">
              <input
                type="checkbox"
                checked={makePrimaryOnAdd}
                onChange={(e) => setMakePrimaryOnAdd(e.target.checked)}
                className="rounded border-slate-300 text-blue-600 focus:ring-blue-600"
              />
              <span>Set as primary active key immediately</span>
            </label>
          </div>

          {/* Saved Key List */}
          <div className="border-t border-slate-200/80 pt-4 space-y-2.5">
            {geminiKeys.length === 0 ? (
              <div className="py-4 text-center text-xs text-slate-500 bg-slate-50/70 border border-slate-200/70 rounded-lg">
                No Gemini API keys configured yet. Add at least one key above to power customer & training AI.
              </div>
            ) : (
              <div className="divide-y divide-slate-100 border border-slate-200/80 rounded-lg">
                {geminiKeys.map((item) => {
                  const statusMeta = formatKeyStatus(item);
                  const isBusy = busyKeyId === item.id;
                  return (
                    <div
                      key={item.id}
                      className="p-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                    >
                      <div className="min-w-0 space-y-1">
                        <div className="flex flex-wrap items-center gap-2 text-xs">
                          <KeyRound className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                          <span className="font-semibold text-slate-900">{item.label}</span>
                          <span className="text-slate-300">·</span>
                          <span className="font-mono text-slate-600">{item.maskedKey}</span>
                          <span className="text-slate-300">·</span>
                          <span className={statusMeta.className}>{statusMeta.text}</span>
                        </div>
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-slate-500 pl-5 tabular-nums">
                          <span>{item.requestCount} requests</span>
                          {item.lastUsedAt && (
                            <>
                              <span>·</span>
                              <span>Last used {new Date(item.lastUsedAt).toLocaleTimeString()}</span>
                            </>
                          )}
                          {item.source === 'env' && (
                            <>
                              <span>·</span>
                              <span>Fallback from server env</span>
                            </>
                          )}
                        </div>
                        {item.lastError && (
                          <p className="text-[11px] text-red-600 pl-5 truncate max-w-md">
                            {item.lastError}
                          </p>
                        )}
                      </div>

                      <div className="flex flex-wrap items-center gap-1.5 pl-5 sm:pl-0 shrink-0">
                        {!item.isCurrent && item.isActive && (
                          <button
                            type="button"
                            disabled={isBusy}
                            onClick={() =>
                              void handleUpdateGeminiKey(item.id, {
                                makePrimary: true,
                                resetStatus: true,
                              })
                            }
                            className="px-2.5 py-1 text-[11px] font-medium text-blue-700 bg-blue-50 hover:bg-blue-100 rounded-md cursor-pointer disabled:opacity-50"
                          >
                            Use Now
                          </button>
                        )}
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() => void handleTestGeminiKey(item.id)}
                          className="px-2.5 py-1 text-[11px] font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 rounded-md cursor-pointer disabled:opacity-50"
                        >
                          {isBusy ? 'Testing...' : 'Test'}
                        </button>
                        {item.source === 'settings' && (
                          <>
                            <button
                              type="button"
                              disabled={isBusy}
                              onClick={() =>
                                void handleUpdateGeminiKey(item.id, { isActive: !item.isActive })
                              }
                              className="px-2.5 py-1 text-[11px] font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 rounded-md cursor-pointer disabled:opacity-50"
                            >
                              {item.isActive ? 'Disable' : 'Enable'}
                            </button>
                            <button
                              type="button"
                              disabled={isBusy}
                              onClick={() => void handleDeleteGeminiKey(item.id)}
                              aria-label={`Delete ${item.label}`}
                              className="p-1.5 text-slate-400 hover:text-red-600 rounded-md cursor-pointer disabled:opacity-50"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Main Business & Messenger Settings Form */}
      <form onSubmit={handleSave} className="space-y-8">
        {/* Section 1: Facebook Page & Messenger Webhook */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 pb-8 border-b border-slate-200/80">
          <div>
            <h2 className="text-sm font-semibold text-slate-900">Facebook Page & Webhook</h2>
            <p className="text-xs text-slate-500 mt-1 leading-relaxed">
              Connect one Facebook Page via Meta Graph API. Meta tokens remain in server environment variables.
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
                  <span className="text-slate-500">Gemini API Pool</span>
                  <span className={env.geminiConfigured ? 'text-emerald-700 font-medium tabular-nums' : 'text-red-700 font-medium'}>
                    {env.geminiConfigured
                      ? `Configured (${env.activeGeminiKeysCount ?? 1} active)`
                      : 'No active keys'}
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
    </div>
  );
}
