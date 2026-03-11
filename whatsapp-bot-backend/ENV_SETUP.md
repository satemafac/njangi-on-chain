# WhatsApp Bot Env Setup

The bot now reads the repo root env file by default.

Use:

- canonical template: [`/.env.example`](/Volumes/Developing/njangi-on-chain/.env.example)
- canonical local file: [`/.env.local`](/Volumes/Developing/njangi-on-chain/.env.local)
- full workflow: [`docs/environment.md`](/Volumes/Developing/njangi-on-chain/docs/environment.md)

## Local run

```bash
npm run validate:env
cd whatsapp-bot-backend
npm run dev
```

## Optional override

If you need a non-standard file for the bot only:

```bash
NJANGI_ENV_FILE=/abs/path/to/custom.env npm run dev
```

That override is explicit only. The backend no longer auto-loads `whatsapp-bot-backend/.env.local`.
