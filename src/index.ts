// =============================================================================
// SpanishVIP Teacher Screening Bot — Cloudflare Worker
// =============================================================================
// Flow: /start <applicant_token> → 5 inline-keyboard questions → PASS/FAIL
// Results are POSTed to Make.com. PASS candidates are handed to Maria Camila.
// =============================================================================

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Env {
  BOT_TOKEN: string;
  BOT_KV: KVNamespace;
  MAKE_WEBHOOK_URL: string;
  MARIA_TELEGRAM_LINK: string;
  MIN_WEEKLY_HOURS?: string; // optional string env var; defaults to "15"
}

type Step =
  | "q1_team_role"
  | "q2_weekly_hours"
  | "q3_start_date"
  | "q4_setup"
  | "q5_sop"
  | "completed";

interface Answers {
  team_role?: string;
  weekly_availability?: string;
  start_date?: string;
  setup?: string;
  sop?: string;
}

interface SessionState {
  applicant_token: string;
  step: Step;
  answers: Answers;
  started_at: string; // ISO-8601
  telegram_username?: string;
}

interface RateLimitState {
  timestamps: number[]; // epoch ms of recent actions
}

// Telegram API — minimal types, no external SDK required
interface TelegramUser {
  id: number;
  username?: string;
  first_name: string;
}

interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: { id: number };
  text?: string;
}

interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

interface ResultPayload {
  applicant_token: string;
  telegram_chat_id: number;
  telegram_username?: string;
  result: "pass" | "fail";
  reason: string;
  answers: Answers;
  completed_at: string; // ISO-8601
}

interface QuestionButton {
  text: string;
  data: string; // callback_data value sent back when pressed
}

interface Question {
  key: keyof Answers;
  text: string;
  buttons: QuestionButton[][];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const QUESTIONS: readonly Question[] = [
  {
    key: "team_role",
    text:
      "👋 *Question 1 of 5*\n\n" +
      "Are you applying as a *SpanishVIP team member*?\n\n" +
      "_Note: This is an internal team position — not a marketplace or freelance " +
      "platform like italki or Preply._",
    buttons: [
      [{ text: "✅ Yes, I'm applying as a team member", data: "q1:yes" }],
      [{ text: "❌ No, I prefer marketplace platforms", data: "q1:no" }],
    ],
  },
  {
    key: "weekly_availability",
    text:
      "📅 *Question 2 of 5*\n\n" +
      "How many hours per week are you available to teach?\n\n" +
      "_Choose the option that best reflects your current availability._",
    buttons: [
      [{ text: "⏰ Full-time — 30+ hours/week", data: "q2:full_time" }],
      [{ text: "🕐 Part-time — 15–29 hours/week", data: "q2:part_time" }],
      [{ text: "🔸 Less than 15 hours/week", data: "q2:less_than_15" }],
    ],
  },
  {
    key: "start_date",
    text: "🚀 *Question 3 of 5*\n\nWhen would you be ready to start teaching with SpanishVIP?",
    buttons: [
      [{ text: "🟢 Immediately", data: "q3:immediately" }],
      [{ text: "📆 In 1–2 weeks", data: "q3:one_two_weeks" }],
      [{ text: "🗓 In 1 month or more", data: "q3:one_month_plus" }],
    ],
  },
  {
    key: "setup",
    text:
      "💻 *Question 4 of 5*\n\n" +
      "Do you have *both* of the following?\n\n" +
      "• A stable internet connection\n" +
      "• A quiet, professional teaching space",
    buttons: [
      [{ text: "✅ Yes, I have both", data: "q4:yes" }],
      [{ text: "❌ No / Not yet", data: "q4:no" }],
    ],
  },
  {
    key: "sop",
    text:
      "📋 *Question 5 of 5*\n\n" +
      "SpanishVIP uses a structured curriculum and standard operating procedures (SOPs). " +
      "Are you willing to follow them consistently?",
    buttons: [
      [{ text: "✅ Yes, absolutely", data: "q5:yes" }],
      [{ text: "❌ No, I prefer my own approach", data: "q5:no" }],
    ],
  },
];

// Ordered list of steps (maps directly to QUESTIONS by index)
const STEP_ORDER: Step[] = [
  "q1_team_role",
  "q2_weekly_hours",
  "q3_start_date",
  "q4_setup",
  "q5_sop",
];

// Maps each step to the callback_data prefix used by that step's buttons
const STEP_PREFIX: Record<Step, string> = {
  q1_team_role: "q1",
  q2_weekly_hours: "q2",
  q3_start_date: "q3",
  q4_setup: "q4",
  q5_sop: "q5",
  completed: "",
};

// Maps Q2 answer values to approximate weekly hours for threshold comparison
const HOURS_MAP: Record<string, number> = {
  full_time: 30,
  part_time: 20,
  less_than_15: 0,
};

// KV TTLs
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days
const RATE_LIMIT_TTL_SECONDS = 60; // 1 minute auto-expire for rate limit keys

// Rate limiting config
const RATE_LIMIT_WINDOW_MS = 10_000; // 10-second sliding window
const RATE_LIMIT_MAX_ACTIONS = 5; // max actions allowed per window

// ---------------------------------------------------------------------------
// KV helpers
// ---------------------------------------------------------------------------

async function loadSession(chatId: number, env: Env): Promise<SessionState | null> {
  const raw = await env.BOT_KV.get(String(chatId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SessionState;
  } catch (e) {
    console.error(`Failed to parse session for chatId ${chatId}:`, e);
    return null;
  }
}

async function saveSession(chatId: number, state: SessionState, env: Env): Promise<void> {
  await env.BOT_KV.put(String(chatId), JSON.stringify(state), {
    expirationTtl: SESSION_TTL_SECONDS,
  });
}

async function deleteSession(chatId: number, env: Env): Promise<void> {
  try {
    await env.BOT_KV.delete(String(chatId));
  } catch (e) {
    console.error(`Failed to delete session for chatId ${chatId}:`, e);
  }
}

// ---------------------------------------------------------------------------
// Rate limiting — per-chat sliding window stored in KV
// ---------------------------------------------------------------------------

/**
 * Returns true if the action is allowed, false if rate-limited.
 * Records this action in KV when allowed.
 */
async function checkRateLimit(chatId: number, env: Env): Promise<boolean> {
  const key = `rl:${chatId}`;
  const now = Date.now();
  let state: RateLimitState = { timestamps: [] };

  const raw = await env.BOT_KV.get(key);
  if (raw) {
    try {
      state = JSON.parse(raw) as RateLimitState;
    } catch {
      state = { timestamps: [] };
    }
  }

  // Keep only timestamps within the current window
  const recent = state.timestamps.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);

  if (recent.length >= RATE_LIMIT_MAX_ACTIONS) {
    return false; // over limit — do NOT record
  }

  recent.push(now);
  await env.BOT_KV.put(key, JSON.stringify({ timestamps: recent } satisfies RateLimitState), {
    expirationTtl: RATE_LIMIT_TTL_SECONDS,
  });
  return true;
}

// ---------------------------------------------------------------------------
// Telegram API wrappers
// ---------------------------------------------------------------------------

const TG_API_BASE = "https://api.telegram.org/bot";

async function sendMessage(
  chatId: number,
  text: string,
  replyMarkup: object | null,
  env: Env,
): Promise<void> {
  const body: Record<string, unknown> = {
    chat_id: chatId,
    text,
    parse_mode: "Markdown",
  };
  if (replyMarkup) {
    body.reply_markup = replyMarkup;
  }

  const resp = await fetch(`${TG_API_BASE}${env.BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    console.error(`sendMessage to chatId ${chatId} failed (${resp.status}):`, errText);
  }
}

async function answerCallbackQuery(
  callbackQueryId: string,
  env: Env,
  text?: string,
): Promise<void> {
  const body: Record<string, unknown> = { callback_query_id: callbackQueryId };
  if (text) {
    body.text = text;
    body.show_alert = false;
  }

  const resp = await fetch(`${TG_API_BASE}${env.BOT_TOKEN}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    console.error(`answerCallbackQuery (${callbackQueryId}) failed (${resp.status}):`, errText);
  }
}

// ---------------------------------------------------------------------------
// Conversation helpers
// ---------------------------------------------------------------------------

async function sendQuestion(chatId: number, questionIndex: number, env: Env): Promise<void> {
  const question = QUESTIONS[questionIndex];
  const inlineKeyboard = {
    inline_keyboard: question.buttons.map((row) =>
      row.map((btn) => ({ text: btn.text, callback_data: btn.data })),
    ),
  };
  await sendMessage(chatId, question.text, inlineKeyboard, env);
}

/**
 * Pure function — checks if the given answer to the given step triggers a fail.
 * Returns a human-readable failure reason, or null if the answer passes.
 */
function checkFailCondition(
  step: Step,
  answer: string,
  minWeeklyHours: number,
): string | null {
  switch (step) {
    case "q1_team_role":
      if (answer === "no") {
        return "Not applying as a SpanishVIP team member";
      }
      break;

    case "q2_weekly_hours": {
      const hours = HOURS_MAP[answer] ?? 0;
      if (hours < minWeeklyHours) {
        return `Availability (approx. ${hours}h/week) is below the minimum required (${minWeeklyHours}h/week)`;
      }
      break;
    }

    case "q4_setup":
      if (answer === "no") {
        return "Does not have stable internet and/or a professional teaching space";
      }
      break;

    case "q5_sop":
      if (answer === "no") {
        return "Unwilling to follow SpanishVIP curriculum and SOPs";
      }
      break;
  }
  return null;
}

/**
 * Posts result to Make.com, sends user-facing message, and cleans up KV session.
 */
async function reportResult(
  result: "pass" | "fail",
  reason: string,
  state: SessionState,
  chatId: number,
  from: TelegramUser,
  env: Env,
): Promise<void> {
  const payload: ResultPayload = {
    applicant_token: state.applicant_token,
    telegram_chat_id: chatId,
    telegram_username: from.username,
    result,
    reason,
    answers: state.answers,
    completed_at: new Date().toISOString(),
  };

  // Fire-and-forget — don't await external webhook, keep UX fast
  fetch(env.MAKE_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }).catch((e) => console.error("Make.com webhook POST failed:", e));

  // Send user-facing result message
  if (result === "pass") {
    await sendMessage(
      chatId,
      "🎉 *Congratulations!* You've passed the initial screening.\n\n" +
        "Our team will review your application and reach out soon.\n\n" +
        "In the meantime, you can also connect directly with our coordinator:\n" +
        env.MARIA_TELEGRAM_LINK,
      null,
      env,
    );
  } else {
    await sendMessage(
      chatId,
      "Thank you for your interest in SpanishVIP! 🙏\n\n" +
        "Based on your answers, we're not able to move forward at this time.\n\n" +
        `_Reason: ${reason}_\n\n` +
        "We appreciate you taking the time and wish you all the best in your teaching career!",
      null,
      env,
    );
  }

  // Mark completed and clean up — mark first so stale callbacks are idempotent
  state.step = "completed";
  await saveSession(chatId, state, env);
  await deleteSession(chatId, env);
}

// ---------------------------------------------------------------------------
// /start handler
// ---------------------------------------------------------------------------

async function handleStart(
  chatId: number,
  from: TelegramUser,
  token: string,
  env: Env,
): Promise<void> {
  if (!token || token.trim().length < 4) {
    await sendMessage(
      chatId,
      "⚠️ *Invalid or missing screening token.*\n\n" +
        "Please use the *Telegram link* that was sent to you in the application confirmation email.\n\n" +
        "If you believe this is an error, contact our support team.",
      null,
      env,
    );
    return;
  }

  const state: SessionState = {
    applicant_token: token.trim(),
    step: "q1_team_role",
    answers: {},
    started_at: new Date().toISOString(),
    telegram_username: from.username,
  };

  await saveSession(chatId, state, env);

  await sendMessage(
    chatId,
    `👋 Hi *${from.first_name}*! Welcome to the SpanishVIP teacher screening.\n\n` +
      "We have *5 quick questions* to see if you're a great fit for our team. " +
      "Answer each one using the buttons — it only takes about a minute!\n\n" +
      "_Let's get started:_",
    null,
    env,
  );

  await sendQuestion(chatId, 0, env);
}

// ---------------------------------------------------------------------------
// Message handler (commands + plain text)
// ---------------------------------------------------------------------------

async function handleMessage(
  chatId: number,
  from: TelegramUser,
  text: string | undefined,
  env: Env,
): Promise<void> {
  // Rate limit check
  const allowed = await checkRateLimit(chatId, env);
  if (!allowed) {
    await sendMessage(
      chatId,
      "⏳ You're sending messages too quickly. Please wait a moment before trying again.",
      null,
      env,
    );
    return;
  }

  const trimmed = (text ?? "").trim();

  // /start [token]
  if (trimmed.startsWith("/start")) {
    const parts = trimmed.split(/\s+/);
    const token = parts[1] ?? "";
    if (!token) {
      await sendMessage(
        chatId,
        "⚠️ *No screening token found.*\n\n" +
          "To start your screening, please open the *Telegram link* from your application email — " +
          "it contains a unique token that identifies you.\n\n" +
          "If you haven't received the email, check your spam folder.",
        null,
        env,
      );
      return;
    }
    await handleStart(chatId, from, token, env);
    return;
  }

  // /restart
  if (trimmed.startsWith("/restart")) {
    const session = await loadSession(chatId, env);
    if (session?.applicant_token) {
      await handleStart(chatId, from, session.applicant_token, env);
    } else {
      await sendMessage(
        chatId,
        "🔄 *No active session found.*\n\n" +
          "Please open the *Telegram link* from your application email to start your screening.",
        null,
        env,
      );
    }
    return;
  }

  // /help
  if (trimmed.startsWith("/help")) {
    await sendMessage(
      chatId,
      "*SpanishVIP Teacher Screening Bot* 🤖\n\n" +
        "This bot guides teacher applicants through a short screening to join the SpanishVIP team.\n\n" +
        "*How it works:*\n" +
        "1\\. You apply through our form and receive a unique Telegram link by email\n" +
        "2\\. Click the link to open this bot and start the screening\n" +
        "3\\. Answer 5 short questions using the inline buttons\n" +
        "4\\. Our team reviews your answers and follows up with next steps\n\n" +
        "*Commands:*\n" +
        "/start — Begin screening (requires your unique link from the email)\n" +
        "/restart — Restart the screening using your current session\n" +
        "/help — Show this help message\n\n" +
        "Need help? Contact us through the SpanishVIP website.",
      null,
      env,
    );
    return;
  }

  // Any other text — check if they're mid-screening
  const session = await loadSession(chatId, env);
  if (session && session.step !== "completed") {
    await sendMessage(
      chatId,
      "👆 Please use the *buttons* to answer the current question.",
      null,
      env,
    );
    return;
  }

  // No active session or already completed
  await sendMessage(
    chatId,
    "👋 To start your SpanishVIP teacher screening, please use the *Telegram link* " +
      "from your application email.\n\nType /help for more information.",
    null,
    env,
  );
}

// ---------------------------------------------------------------------------
// Callback query handler (button presses)
// ---------------------------------------------------------------------------

async function handleCallbackQuery(cq: TelegramCallbackQuery, env: Env): Promise<void> {
  const chatId = cq.from.id;
  const callbackQueryId = cq.id;
  const data = cq.data ?? "";

  // Always acknowledge immediately to remove Telegram's loading spinner
  await answerCallbackQuery(callbackQueryId, env);

  // Rate limit check
  const allowed = await checkRateLimit(chatId, env);
  if (!allowed) {
    await sendMessage(
      chatId,
      "⏳ You're clicking too quickly. Please wait a moment before continuing.",
      null,
      env,
    );
    return;
  }

  // Load session
  const state = await loadSession(chatId, env);
  if (!state) {
    await sendMessage(
      chatId,
      "⚠️ Your session has expired or was not found.\n\n" +
        "Please use the *Telegram link* from your application email to start a new screening.",
      null,
      env,
    );
    return;
  }

  // Screening already finished — ignore stale button taps
  if (state.step === "completed") {
    return;
  }

  // Parse callback data format: "q1:yes" → qPrefix="q1", answerValue="yes"
  const colonIdx = data.indexOf(":");
  if (colonIdx === -1) {
    console.error("Unexpected callback_data format (no colon):", data);
    return;
  }
  const qPrefix = data.slice(0, colonIdx);
  const answerValue = data.slice(colonIdx + 1);

  // Validate that the pressed button belongs to the current step
  // (guards against stale messages from a previous question)
  const expectedPrefix = STEP_PREFIX[state.step];
  if (qPrefix !== expectedPrefix) {
    return; // silently ignore
  }

  // Find the current question
  const stepIndex = STEP_ORDER.indexOf(state.step);
  if (stepIndex === -1) {
    console.error("Unknown step in session state:", state.step);
    return;
  }
  const question = QUESTIONS[stepIndex];

  // Record the answer
  state.answers[question.key] = answerValue;

  // Determine minimum weekly hours threshold
  const minWeeklyHours = parseInt(env.MIN_WEEKLY_HOURS ?? "15", 10) || 15;

  // Check fail condition
  const failReason = checkFailCondition(state.step, answerValue, minWeeklyHours);
  if (failReason) {
    await reportResult("fail", failReason, state, chatId, cq.from, env);
    return;
  }

  // Advance to the next step
  const nextStepIndex = stepIndex + 1;
  if (nextStepIndex >= STEP_ORDER.length) {
    // All questions answered — PASS
    await reportResult("pass", "", state, chatId, cq.from, env);
    return;
  }

  state.step = STEP_ORDER[nextStepIndex];
  await saveSession(chatId, state, env);
  await sendQuestion(chatId, nextStepIndex, env);
}

// ---------------------------------------------------------------------------
// Main webhook handler
// ---------------------------------------------------------------------------

async function handleWebhook(request: Request, env: Env): Promise<void> {
  let update: TelegramUpdate;
  try {
    update = (await request.json()) as TelegramUpdate;
  } catch (e) {
    console.error("Failed to parse Telegram update body:", e);
    return;
  }

  if (update.callback_query) {
    const cq = update.callback_query;
    try {
      await handleCallbackQuery(cq, env);
    } catch (e) {
      console.error(`Error handling callback_query from chatId ${cq.from.id}:`, e);
    }
  } else if (update.message) {
    const msg = update.message;
    const chatId = msg.chat.id;
    const from: TelegramUser = msg.from ?? { id: chatId, first_name: "there" };
    try {
      await handleMessage(chatId, from, msg.text, env);
    } catch (e) {
      console.error(`Error handling message for chatId ${chatId}:`, e);
    }
  }
  // Other update types (edited_message, channel_post, etc.) are intentionally ignored
}

// ---------------------------------------------------------------------------
// Cloudflare Worker entry point
// ---------------------------------------------------------------------------

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Health check endpoint
    if (request.method === "GET" && url.pathname === "/health") {
      return new Response("ok", { status: 200 });
    }

    // Telegram webhook endpoint
    if (request.method === "POST" && url.pathname === "/telegram/webhook") {
      try {
        await handleWebhook(request, env);
      } catch (e) {
        // Never propagate errors — Telegram expects HTTP 200 always
        console.error("Unhandled error in handleWebhook:", e);
      }
      return new Response("ok", { status: 200 });
    }

    return new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
