// =============================================================================
// SpanishVIP Teacher Screening Bot — Cloudflare Worker
// =============================================================================
// Flow: /start <applicant_token> → 8 inline-keyboard questions → PASS/FAIL
// Results are POSTed to Make.com. PASS candidates are handed to Maria Camila.
// =============================================================================

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Env {
  BOT_TOKEN: string;
  BOT_KV: KVNamespace;
  MAKE_WEBHOOK_URL: string;
  MARIA_WHATSAPP_LINK: string;
  MIN_WEEKLY_HOURS?: string; // optional string env var; defaults to "15"
}

type Step =
  | "q1_team_role"
  | "q2_weekly_hours"
  | "q3_start_date"
  | "q4_setup"
  | "q5_sop"
  | "q6_english"
  | "q7_age"
  | "q8_student_types"
  | "completed";

interface Answers {
  team_role?: string;
  weekly_availability?: string;
  start_date?: string;
  setup?: string;
  sop?: string;
  english_level?: string;
  age?: number;
  student_types?: string;
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
  buttons: QuestionButton[][]; // empty for Q7 (free-text age input)
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const QUESTIONS: readonly Question[] = [
  {
    key: "team_role",
    text:
      "<b>Q1/8</b> 🧩\n" +
      "En SpanishVIP buscamos un rol de <b>equipo</b> (no estilo marketplace).\n" +
      "¿Buscas un rol fijo y comprometido con el equipo?",
    buttons: [
      [{ text: "1) ✅ Sí", data: "Q1_YES" }],
      [{ text: "2) ❌ No", data: "Q1_NO" }],
    ],
  },
  {
    key: "weekly_availability",
    text:
      "<b>Q2/8</b> 🗓️\n" +
      "¿Cuántas horas por semana puedes comprometerte de forma constante?",
    buttons: [
      [{ text: "1) 💪 Tiempo completo (30+ hrs/sem)", data: "Q2_FT" }],
      [{ text: "2) 🙂 Medio tiempo (15–29 hrs/sem)", data: "Q2_PT" }],
      [{ text: "3) 🥲 Menos de 15 hrs/sem", data: "Q2_LOW" }],
    ],
  },
  {
    key: "start_date",
    text: "<b>Q3/8</b> ⏱️\n¿Cuándo podrías empezar?",
    buttons: [
      [{ text: "1) 🚀 Inmediatamente", data: "Q3_NOW" }],
      [{ text: "2) 📆 En 1–2 semanas", data: "Q3_SOON" }],
      [{ text: "3) 🗓️ En 1 mes o más", data: "Q3_LATER" }],
    ],
  },
  {
    key: "setup",
    text:
      "<b>Q4/8</b> 💻🎧\n" +
      "¿Tienes internet estable + un lugar tranquilo para enseñar?",
    buttons: [
      [{ text: "1) ✅ Sí", data: "Q4_YES" }],
      [{ text: "2) ❌ No", data: "Q4_NO" }],
    ],
  },
  {
    key: "sop",
    text:
      "<b>Q5/8</b> 📚✨\n" +
      "¿Estás de acuerdo en seguir el currículum y los SOPs del equipo?",
    buttons: [
      [{ text: "1) ✅ Sí", data: "Q5_YES" }],
      [{ text: "2) ❌ No", data: "Q5_NO" }],
    ],
  },
  {
    key: "english_level",
    text:
      "<b>Q6/8</b> 🇺🇸🗣️\n" +
      "¿Cuál es tu nivel de inglés?",
    buttons: [
      [{ text: "1) ✅ Bueno", data: "Q6_GOOD" }],
      [{ text: "2) 🙂 Me defiendo", data: "Q6_OK" }],
      [{ text: "3) ❌ No sé mucho", data: "Q6_LOW" }],
    ],
  },
  {
    key: "age",
    text:
      "<b>Q7/8</b> 🎂\n" +
      "¿Cuál es tu edad?\n" +
      "(Escribe solo el número, por ejemplo: 24)",
    buttons: [], // free-text input — no inline keyboard
  },
  {
    key: "student_types",
    text: "<b>Q8/8</b> 👩‍🏫\n¿A qué tipo de estudiantes has enseñado?",
    buttons: [
      [{ text: "1) Niños 👧🧒", data: "Q8_KIDS" }],
      [{ text: "2) Jóvenes 🎓", data: "Q8_TEENS" }],
      [{ text: "3) Adultos 💼", data: "Q8_ADULTS" }],
      [{ text: "4) Todos los anteriores 🌟", data: "Q8_ALL" }],
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
  "q6_english",
  "q7_age",
  "q8_student_types",
];

// Maps each step to the callback_data prefix used by that step's buttons
const STEP_PREFIX: Record<Step, string> = {
  q1_team_role: "Q1",
  q2_weekly_hours: "Q2",
  q3_start_date: "Q3",
  q4_setup: "Q4",
  q5_sop: "Q5",
  q6_english: "Q6",
  q7_age: "Q7",
  q8_student_types: "Q8",
  completed: "",
};

// Maps callback suffix → canonical answer value for each question prefix
const CALLBACK_VALUE_MAP: Record<string, Record<string, string>> = {
  Q1: { YES: "yes", NO: "no" },
  Q2: { FT: "full_time", PT: "part_time", LOW: "low" },
  Q3: { NOW: "now", SOON: "soon", LATER: "later" },
  Q4: { YES: "yes", NO: "no" },
  Q5: { YES: "yes", NO: "no" },
  Q6: { GOOD: "good", OK: "ok", LOW: "low" },
  Q8: { KIDS: "kids", TEENS: "teens", ADULTS: "adults", ALL: "all" },
};

// Maps Q2 canonical answer values to approximate weekly hours for threshold comparison
const HOURS_MAP: Record<string, number> = {
  full_time: 30,
  part_time: 20,
  low: 0,
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

  const recent = state.timestamps.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);

  if (recent.length >= RATE_LIMIT_MAX_ACTIONS) {
    return false;
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
    parse_mode: "HTML",
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
  if (question.buttons.length === 0) {
    // Q7 age — no buttons, just text prompt
    await sendMessage(chatId, question.text, null, env);
    return;
  }
  const inlineKeyboard = {
    inline_keyboard: question.buttons.map((row) =>
      row.map((btn) => ({ text: btn.text, callback_data: btn.data })),
    ),
  };
  await sendMessage(chatId, question.text, inlineKeyboard, env);
}

/**
 * Pure function — checks if the given answer to the given step triggers a fail.
 * Returns the user-facing Spanish failure message, or null if the answer passes.
 */
function checkFailCondition(
  step: Step,
  answer: string,
  minWeeklyHours: number,
): string | null {
  switch (step) {
    case "q1_team_role":
      if (answer === "no") {
        return (
          "💛 ¡Gracias por tu interés!\n" +
          "En este momento buscamos candidatos para un rol fijo de equipo.\n" +
          "🙏 Te deseamos mucho éxito."
        );
      }
      break;

    case "q2_weekly_hours": {
      const hours = HOURS_MAP[answer] ?? 0;
      if (hours < minWeeklyHours) {
        return (
          "💛 ¡Gracias!\n" +
          `En este momento necesitamos un compromiso mínimo de ${minWeeklyHours} horas semanales.\n` +
          "🙏 Te agradecemos tu tiempo."
        );
      }
      break;
    }

    case "q4_setup":
      if (answer === "no") {
        return (
          "💛 ¡Gracias!\n" +
          "Para este rol es necesario contar con internet estable y un espacio tranquilo.\n" +
          "🙏 Te deseamos lo mejor."
        );
      }
      break;

    case "q5_sop":
      if (answer === "no") {
        return (
          "💛 ¡Gracias!\n" +
          "Es importante seguir el currículum y los SOPs del equipo.\n" +
          "🙏 Te agradecemos tu interés."
        );
      }
      break;

    case "q6_english":
      if (answer === "low") {
        return (
          "💛 ¡Gracias!\n" +
          "Para este rol necesitamos al menos un nivel intermedio de inglés.\n" +
          "🙏 Te deseamos mucho éxito."
        );
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
      "🎉 <b>¡Excelente! Has pasado el pre-filtro</b> ✅\n\n" +
        "🧑‍💼 Siguiente paso: hablar con una persona del equipo para coordinar tu <b>primera entrevista</b>.\n\n" +
        "👉 Escribe aquí a <b>Maria Camila</b> para continuar:\n" +
        env.MARIA_WHATSAPP_LINK + "\n\n" +
        "💬 <i>Mensaje sugerido:</i>\n" +
        '"Hola Maria, pasé el pre-filtro de SpanishVIP. Mi nombre es ___ y mi correo es ___."',
      null,
      env,
    );
  } else {
    // reason already contains the full user-facing Spanish message
    await sendMessage(chatId, reason, null, env);
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
      "⚠️ Por favor usa el enlace de aplicación para empezar.",
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
      "⏳ Estás enviando mensajes muy rápido. Espera un momento.",
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
        "⚠️ Por favor usa el enlace de aplicación para empezar.",
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
        "🔄 No se encontró una sesión activa. Usa el enlace de tu correo para empezar.",
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
      "<b>SpanishVIP — Bot de Pre-filtro</b> 🤖\n\n" +
        "Este bot realiza un screening rápido para candidatos a profesor.\n\n" +
        "/start — Iniciar (requiere el enlace de tu correo)\n" +
        "/restart — Reiniciar el screening\n" +
        "/help — Mostrar este mensaje",
      null,
      env,
    );
    return;
  }

  // Check if they're mid-screening
  const session = await loadSession(chatId, env);
  if (session && session.step !== "completed") {
    // Q7 age — expects free text
    if (session.step === "q7_age") {
      const parsed = parseInt(trimmed, 10);
      if (isNaN(parsed) || parsed < 10 || parsed > 80) {
        await sendMessage(
          chatId,
          "😊 Por favor escribe tu edad en números (ej: 24).",
          null,
          env,
        );
        return;
      }

      session.answers.age = parsed;

      if (parsed >= 35) {
        await reportResult(
          "fail",
          "💛 ¡Gracias!\n" +
            "En este momento estamos buscando candidatos <b>menores de 35 años</b> para este rol.\n" +
            "🙏 Te agradecemos tu tiempo y tu interés en SpanishVIP.",
          session,
          chatId,
          from,
          env,
        );
        return;
      }

      // Age OK — advance to Q8
      const nextStepIndex = STEP_ORDER.indexOf("q7_age") + 1;
      session.step = STEP_ORDER[nextStepIndex];
      await saveSession(chatId, session, env);
      await sendQuestion(chatId, nextStepIndex, env);
      return;
    }

    // Any other step — prompt to use buttons
    await sendMessage(
      chatId,
      "👆 Por favor usa los <b>botones</b> para responder.",
      null,
      env,
    );
    return;
  }

  // No active session or already completed
  await sendMessage(
    chatId,
    "👋 Para iniciar tu screening, usa el enlace que recibiste por correo.\n\nEscribe /help para más información.",
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
      "⏳ Estás enviando mensajes muy rápido. Espera un momento.",
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
      "⚠️ Tu sesión ha expirado. Usa el enlace de tu correo para iniciar de nuevo.",
      null,
      env,
    );
    return;
  }

  // Screening already finished — ignore stale button taps
  if (state.step === "completed") {
    return;
  }

  // Parse callback data format: "Q1_YES" → qPrefix="Q1", callbackSuffix="YES"
  const underscoreIdx = data.indexOf("_");
  if (underscoreIdx === -1) {
    console.error("Unexpected callback_data format (no underscore):", data);
    return;
  }
  const qPrefix = data.slice(0, underscoreIdx);
  const callbackSuffix = data.slice(underscoreIdx + 1);

  // Validate that the pressed button belongs to the current step
  const expectedPrefix = STEP_PREFIX[state.step];
  if (qPrefix !== expectedPrefix) {
    return; // silently ignore stale button
  }

  // Look up canonical answer value
  const prefixMap = CALLBACK_VALUE_MAP[qPrefix];
  if (!prefixMap) {
    console.error("No CALLBACK_VALUE_MAP entry for prefix:", qPrefix);
    return;
  }
  const answerValue = prefixMap[callbackSuffix];
  if (!answerValue) {
    console.error("Unknown callback suffix:", callbackSuffix, "for prefix:", qPrefix);
    return;
  }

  // Find the current question
  const stepIndex = STEP_ORDER.indexOf(state.step);
  if (stepIndex === -1) {
    console.error("Unknown step in session state:", state.step);
    return;
  }
  const question = QUESTIONS[stepIndex];

  // Record the answer
  (state.answers as Record<string, unknown>)[question.key] = answerValue;

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
