You are a senior engineer. Build a production-ready Telegram screening bot on Cloudflare Workers for SpanishVIP teacher applicants.

GOAL
- Applicants submit via Facebook Lead Form -> row in Google Sheet -> we email them a Telegram deep link.
- They must click the Telegram link and start the bot (no cold messaging).
- Bot runs a short screening with inline keyboard buttons.
- Bot returns PASS/FAIL and answers to our backend via a webhook (Make.com webhook URL).
- Bot hands off PASS candidates to a human (Maria Camila) via a Telegram link/username.
- Everything should be “free tier friendly”.

TECH STACK
- Cloudflare Workers (JavaScript or TypeScript)
- Cloudflare KV for user session state
- Telegram Bot API via fetch
- Optional: HMAC signing for start payload; BUT simplest acceptable security is using a random applicant_token generated upstream (UUID) and passed in /start payload, so no HMAC required.

REQUIREMENTS
1) Endpoints
- POST /telegram/webhook  (Telegram webhook posts updates here)
- GET /health            (returns “ok”)

2) Environment / bindings
- BOT_TOKEN (Telegram bot token)
- BOT_KV (KV namespace binding)
- MAKE_WEBHOOK_URL (where to POST final results)
- MARIA_TELEGRAM_LINK (e.g. https://t.me/mariacamilaxyz)
- OPTIONAL: MIN_WEEKLY_HOURS integer default 15

3) Start payload
- Bot expects /start <applicant_token>
- Store mapping: chat_id -> { applicant_token, step, answers, started_at }
- If user runs /start without token: show friendly error and instructions.

4) Conversation design (inline keyboard)
- Short intro
- Q1 Team role (not marketplace/freelance italki/Preply): Yes/No
- Q2 Weekly availability: Full-time (30+), Part-time (15–29), Less than 15
- Q3 Start date: Immediately / 1–2 weeks / 1 month+
- Q4 Setup: stable internet + quiet space: Yes/No
- Q5 SOP: willing to follow curriculum/SOPs: Yes/No
- If any fail condition triggers: FAIL and end
- PASS if they meet requirements

Fail conditions:
- Q1 = No
- Q2 = Less than 15 (or below MIN_WEEKLY_HOURS if configured)
- Q4 = No
- Q5 = No

5) Results reporting
On PASS or FAIL:
- POST to MAKE_WEBHOOK_URL JSON:
{
  "applicant_token": "...",
  "telegram_chat_id": 123,
  "telegram_username": "optional",
  "result": "pass"|"fail",
  "reason": "string if fail else empty",
  "answers": {
     "team_role": "...",
     "weekly_availability": "...",
     "start_date": "...",
     "setup": "...",
     "sop": "..."
  },
  "completed_at": "ISO-8601"
}
- Then clear KV state for this chat.

6) UX details
- Use answerCallbackQuery to remove “loading” on button click.
- Edit previous message when possible (optional) to keep chat tidy; if too complex, just send the next question.
- Provide /restart command to restart using the last known applicant_token if present; otherwise instruct to use the email link.
- Provide /help that explains what this is.
- Add basic rate limiting to prevent spam on a per-chat basis (e.g., ignore > 5 actions in 10 seconds).

7) Robustness
- Handle callback_query updates and message updates.
- Handle unexpected input: “Please use the buttons”.
- KV session TTL: 7 days (or store timestamp and expire manually).
- Log errors with console.error.
- Return 200 quickly to Telegram.

DELIVERABLES
- Full Worker code (single file ok) + wrangler.toml example showing KV binding.
- Instructions to deploy: create worker, bind KV, set env vars, set Telegram webhook.
- Sample curl commands to test the endpoints locally.
- Clearly labeled sections: “Code”, “wrangler.toml”, “Deployment steps”, “How to set webhook”, “Make payload format”.
