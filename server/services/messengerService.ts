const GRAPH_API_BASE = 'https://graph.facebook.com/v21.0';

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  attempts = 3,
): Promise<globalThis.Response> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, init);
      if (res.status >= 500 || res.status === 429) {
        lastErr = new Error(`Meta Graph API transient HTTP ${res.status}`);
        await new Promise((r) => setTimeout(r, 300 * Math.pow(2, i)));
        continue;
      }
      return res;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 300 * Math.pow(2, i)));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('Meta Graph API request failed.');
}

export async function sendMessengerText(params: {
  recipientId: string;
  text: string;
}): Promise<{ messageId?: string; skipped?: boolean; reason?: string }> {
  const accessToken = process.env.META_PAGE_ACCESS_TOKEN?.trim();
  if (!accessToken) {
    return {
      skipped: true,
      reason: 'META_PAGE_ACCESS_TOKEN is not configured on the server.',
    };
  }

  // Split long replies cleanly within Messenger's 2000-character message limit
  const chunks: string[] = [];
  const cleanText = params.text.trim();
  for (let i = 0; i < cleanText.length; i += 1900) {
    chunks.push(cleanText.slice(i, i + 1900));
  }

  let lastMessageId: string | undefined;
  for (const chunk of chunks) {
    const res = await fetchWithRetry(
      `${GRAPH_API_BASE}/me/messages?access_token=${encodeURIComponent(accessToken)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messaging_type: 'RESPONSE',
          recipient: { id: params.recipientId },
          message: { text: chunk },
        }),
      },
    );

    const data = (await res.json()) as {
      message_id?: string;
      error?: { message?: string; code?: number };
    };

    if (!res.ok || data.error) {
      throw new Error(data.error?.message || `Messenger Send API failed (${res.status})`);
    }
    lastMessageId = data.message_id;
  }

  return { messageId: lastMessageId };
}

export async function fetchMessengerUserProfile(psid: string): Promise<{
  name?: string;
  profilePic?: string;
}> {
  const accessToken = process.env.META_PAGE_ACCESS_TOKEN?.trim();
  if (!accessToken) return {};

  try {
    const res = await fetch(
      `${GRAPH_API_BASE}/${encodeURIComponent(psid)}?fields=first_name,last_name,profile_pic&access_token=${encodeURIComponent(accessToken)}`,
    );
    if (!res.ok) return {};
    const data = (await res.json()) as {
      first_name?: string;
      last_name?: string;
      profile_pic?: string;
    };
    const fullName = [data.first_name, data.last_name].filter(Boolean).join(' ').trim();
    return {
      name: fullName || undefined,
      profilePic: data.profile_pic || undefined,
    };
  } catch {
    return {};
  }
}

export async function verifyFacebookPageConnection(): Promise<{
  connected: boolean;
  pageId?: string;
  pageName?: string;
  error?: string;
}> {
  const accessToken = process.env.META_PAGE_ACCESS_TOKEN?.trim();
  if (!accessToken) {
    return {
      connected: false,
      error: 'META_PAGE_ACCESS_TOKEN is not configured in server environment variables.',
    };
  }

  try {
    const res = await fetch(
      `${GRAPH_API_BASE}/me?fields=id,name&access_token=${encodeURIComponent(accessToken)}`,
    );
    const data = (await res.json()) as {
      id?: string;
      name?: string;
      error?: { message?: string };
    };
    if (!res.ok || data.error || !data.id) {
      return {
        connected: false,
        error: data.error?.message || 'Unable to verify Facebook Page token.',
      };
    }
    return {
      connected: true,
      pageId: data.id,
      pageName: data.name || 'Connected Page',
    };
  } catch (err) {
    return {
      connected: false,
      error: err instanceof Error ? err.message : 'Network error connecting to Meta Graph API.',
    };
  }
}
