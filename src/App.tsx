import { useEffect, useState } from 'react';
import { Menu } from 'lucide-react';
import { AuthGate } from './components/AuthGate';
import { ConversationsPage } from './components/ConversationsPage';
import { OrdersPage } from './components/OrdersPage';
import { OverviewPage } from './components/OverviewPage';
import { ProductsPage } from './components/ProductsPage';
import { Sidebar } from './components/Sidebar';
import { SettingsPage } from './components/SettingsPage';
import { api, setAuthToken, setUnauthorizedHandler } from './lib/api';
import type { AdminUser, AuthBootstrapStatus, NavSection } from './types';

const SECTION_TITLES: Record<NavSection, string> = {
  overview: 'Overview',
  conversations: 'Conversations',
  products: 'Products',
  orders: 'Orders',
  settings: 'Settings',
};

export default function App() {
  const [authStatus, setAuthStatus] = useState<AuthBootstrapStatus | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [admin, setAdmin] = useState<AdminUser | null>(null);

  const [section, setSection] = useState<NavSection>('overview');
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  async function checkBootstrap() {
    setAuthError(null);
    try {
      const status = await api.getAuthStatus();
      setAuthStatus(status);
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : 'Unable to reach server.');
    }
  }

  useEffect(() => {
    setUnauthorizedHandler(() => {
      setAdmin(null);
      void checkBootstrap();
    });
    void checkBootstrap();
  }, []);

  function handleNavigate(next: NavSection, conversationId?: string) {
    setSection(next);
    if (conversationId) {
      setSelectedConversationId(conversationId);
    }
  }

  function handleSignOut() {
    setAuthToken(null);
    setAdmin(null);
    void checkBootstrap();
  }

  if (authError) {
    return (
      <div className="min-h-screen bg-[#f8fafc] flex items-center justify-center p-4">
        <div className="bg-white border border-slate-200 rounded-xl p-6 max-w-sm w-full text-center space-y-3 shadow-[0_1px_3px_rgba(15,23,42,0.04)]">
          <p className="text-sm text-red-700">{authError}</p>
          <button
            type="button"
            onClick={() => void checkBootstrap()}
            className="px-4 py-2 text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg cursor-pointer"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (!authStatus) {
    return (
      <div className="min-h-screen bg-[#f8fafc] flex items-center justify-center">
        <div className="w-5 h-5 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!admin) {
    return (
      <AuthGate
        status={authStatus}
        onAuthenticated={(authenticatedAdmin) => {
          setAdmin(authenticatedAdmin);
        }}
      />
    );
  }

  return (
    <div className="min-h-screen bg-[#f8fafc] flex">
      <Sidebar
        activeSection={section}
        onSelectSection={(next) => handleNavigate(next)}
        admin={admin}
        onSignOut={handleSignOut}
        mobileOpen={mobileMenuOpen}
        onCloseMobile={() => setMobileMenuOpen(false)}
      />

      <div className="flex-1 flex flex-col min-w-0">
        <header className="h-14 bg-white border-b border-slate-200/80 px-4 lg:px-8 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={() => setMobileMenuOpen(true)}
              aria-label="Open navigation"
              className="lg:hidden p-1.5 text-slate-600 hover:text-slate-900 rounded-md cursor-pointer"
            >
              <Menu className="w-5 h-5" />
            </button>
            <div className="flex items-center gap-2 text-sm min-w-0">
              <span className="text-slate-400 hidden sm:inline">Workspace</span>
              <span className="text-slate-300 hidden sm:inline" aria-hidden="true">/</span>
              <h1 className="font-display text-[15px] font-semibold text-slate-900 truncate">
                {SECTION_TITLES[section]}
              </h1>
            </div>
          </div>
        </header>

        <main className="flex-1 p-4 lg:p-8 max-w-7xl w-full mx-auto">
          {section === 'overview' && <OverviewPage onNavigate={handleNavigate} />}
          {section === 'conversations' && (
            <ConversationsPage initialConversationId={selectedConversationId} />
          )}
          {section === 'products' && <ProductsPage />}
          {section === 'orders' && <OrdersPage />}
          {section === 'settings' && <SettingsPage />}
        </main>
      </div>
    </div>
  );
}
