# PageFlow AI — Facebook Messenger Sales Agent

A production-ready AI Facebook Messenger Sales Agent built with React, Node.js, Express, MongoDB, Google Gemini API, and Meta Graph API.

## Environment Configuration

Configure the following server-side environment variables (never prefix these with `VITE_`):

- `GEMINI_API_KEY`: Google Gemini API key for `@google/genai`.
- `MONGODB_URI`: MongoDB connection string (e.g., MongoDB Atlas). When omitted in local preview, the server runs with an in-memory collection store so you can test workflows before attaching MongoDB.
- `MONGODB_DB_NAME`: Database name (defaults to `pageflow_ai`).
- `META_PAGE_ACCESS_TOKEN`: Facebook Page Access Token with `pages_messaging` permission.
- `META_APP_SECRET`: Meta App Secret used to verify `X-Hub-Signature-256` webhook signatures.
- `META_VERIFY_TOKEN`: Custom secret token used for Meta Webhook subscription verification (`GET /api/webhooks/messenger`).
- `ADMIN_EMAIL` / `ADMIN_PASSCODE` (optional): Fixed admin login credentials. If omitted, the first visitor can claim the admin account via the first-run setup screen.
- `APP_URL`: Public HTTPS base URL of the deployed service.

## Meta Messenger Webhook Setup

1. Deploy or expose the application over HTTPS on port `3000`.
2. In your **Meta App Dashboard > Messenger > Settings > Webhooks**:
   - **Callback URL**: `<APP_URL>/api/webhooks/messenger`
   - **Verify Token**: Must match `META_VERIFY_TOKEN`.
   - Subscribe to webhook fields: `messages`, `messaging_postbacks`.
3. In **Settings** inside the dashboard, enter your Facebook Page ID and click **Verify Connection** to confirm your `META_PAGE_ACCESS_TOKEN` is active.

## Running Locally

```bash
npm install
npm run dev
```

## Production Build

```bash
npm run build
npm start
```
