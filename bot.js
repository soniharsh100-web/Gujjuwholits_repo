const TelegramBot = require("node-telegram-bot-api");
const Anthropic = require("@anthropic-ai/sdk");
const schedule = require("node-schedule");
const fs = require("fs");
const path = require("path");
const https = require("https");

// ── Config ──────────────────────────────────────────────────────────────────
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ANTHROPIC_KEY  = process.env.ANTHROPIC_API_KEY;
const DATA_FILE      = path.join(__dirname, "data.json");

if (!TELEGRAM_TOKEN || !ANTHROPIC_KEY) {
  console.error("❌ Missing TELEGRAM_BOT_TOKEN or ANTHROPIC_API_KEY in environment");
  process.exit(1);
}

const bot       = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
const anthropic = new Anthropic({ apiKey: ANTHROPIC_KEY });

// ── Persistent storage ───────────────────────────────────────────────────────
function loadData() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); } catch { return {}; }
}
function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}
function getTodayKey() {
  return new Date().toISOString().split("T")[0];
}
function getUser(data, chatId) {
  if (!data[chatId]) {
    data[chatId] = { profile: {}, logs: {}, history: [], setupStep: "name" };
  }
  return data[chatId];
}
function getTodayLog(user) {
  const key = getTodayKey();
  if (!user.logs[key]) user.logs[key] = { meals: [], calories: 0, protein: 0, workout: false };
  return user.logs[key];
}

// ── Claude AI ────────────────────────────────────────────────────────────────
const SYSTEM = (profile, todayLog) => `You are FitBot 🔥 — a no-fluff, science-based AI coach for body recomposition (simultaneous fat loss + muscle building).

User Profile:
- Name: ${profile.name || "User"}
- Age: ${profile.age || "?"}
- Weight: ${profile.weight || "?"}kg | Height: ${profile.height || "?"}cm
- Goal: Fat loss + muscle building (slow & steady recomposition)
- Calorie target: ~${Math.round((parseFloat(profile.weight) || 70) * 23)} kcal/day
- Protein target: ~${Math.round((parseFloat(profile.weight) || 70) * 2)}g/day

Today's log: ${JSON.stringify(todayLog)}

Rules:
1. FOOD PHOTOS → Estimate calories, protein, carbs, fats. End with ✅ or ⚠️ verdict.
2. WORKOUT VIDEOS/DESCRIPTIONS → Give 3 specific form cues + safety tips for that exercise.
3. CALORIE CHECK → Running daily totals, flag if over/under by >200 kcal.
4. MOTIVATION → Keep it real, no toxic positivity. Recomp takes 3-6 months minimum.
5. FORMAT → Use Telegram markdown (*bold*, _italic_). Keep replies under 250 words.
6. If user says workout done → confirm and log it.
7. Always end food analysis with: "📊 Running total: X kcal / Y g protein today"`;

async function askClaude(profile, todayLog, history, userText, imageBase64 = null) {
  const messages = history.slice(-10).map(m => ({ role: m.role, content: m.content }));

  const lastContent = imageBase64
    ? [
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data: imageBase64 } },
        { type: "text", text: userText }
      ]
    : userText;

  messages.push({ role: "user", content: lastContent });

  const res = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 600,
    system: SYSTEM(profile, todayLog),
    messages,
  });
  return res.content.map(b => b.text || "").join("");
}

// ── Image downloader ─────────────────────────────────────────────────────────
function downloadImage(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks).toString("base64")));
      res.on("error", reject);
    }).on("error", reject);
  });
}

// ── Setup flow ───────────────────────────────────────────────────────────────
const SETUP_STEPS = ["name", "age", "weight", "height"];
const SETUP_PROMPTS = {
  name:   "👋 Welcome to *FitBot*!\n\nI'm your personal body recomposition coach. I'll help you lose fat and build muscle — slow and steady.\n\nLet's set up your profile first.\n\n*What's your name?*",
  age:    "💪 Great! *How old are you?* (e.g. 28)",
  weight: "⚖️ *What's your current weight in kg?* (e.g. 75)",
  height: "📏 *What's your height in cm?* (e.g. 175)",
};

async function handleSetup(chatId, user, text) {
  const step = user.setupStep;
  if (!step || !SETUP_STEPS.includes(step)) return false;

  user.profile[step] = text.trim();

  const nextIdx = SETUP_STEPS.indexOf(step) + 1;
  if (nextIdx < SETUP_STEPS.length) {
    user.setupStep = SETUP_STEPS[nextIdx];
    await bot.sendMessage(chatId, SETUP_PROMPTS[user.setupStep], { parse_mode: "Markdown" });
  } else {
    user.setupStep = "done";
    const w = parseFloat(user.profile.weight) || 70;
    const calTarget = Math.round(w * 23);
    const protTarget = Math.round(w * 2);
    await bot.sendMessage(chatId,
      `✅ *Profile saved!*\n\nHere's your daily recomposition targets:\n\n` +
      `🔥 *Calories:* ${calTarget} kcal\n` +
      `🥩 *Protein:* ${protTarget}g\n` +
      `🏋️ *Training:* 3-4x resistance + 2x cardio/week\n\n` +
      `I'll check in 3x daily:\n🌅 8:00 AM — Breakfast\n☀️ 1:00 PM — Lunch\n🌙 7:00 PM — Dinner\n\n` +
      `*You can also:*\n📸 Send food photos for calorie analysis\n🎥 Send workout videos for form tips\n📊 Type /today to see your daily summary\n\nLet's go! 💪`,
      { parse_mode: "Markdown" }
    );
  }
  return true;
}

// ── Main message handler ─────────────────────────────────────────────────────
bot.on("message", async (msg) => {
  const chatId = String(msg.chat.id);
  const text   = msg.text || "";
  const data   = loadData();
  const user   = getUser(data, chatId);

  // Commands
  if (text === "/start") {
    user.setupStep = "name";
    user.profile   = {};
    user.history   = [];
    saveData(data);
    await bot.sendMessage(chatId, SETUP_PROMPTS.name, { parse_mode: "Markdown" });
    return;
  }

  if (text === "/today") {
    const log = getTodayLog(user);
    const w = parseFloat(user.profile.weight) || 70;
    const calTarget = Math.round(w * 23);
    const protTarget = Math.round(w * 2);
    const remaining = calTarget - (log.calories || 0);
    await bot.sendMessage(chatId,
      `📊 *Today's Summary — ${getTodayKey()}*\n\n` +
      `🔥 Calories: *${log.calories || 0}* / ${calTarget} kcal (${remaining > 0 ? remaining + " remaining" : "target hit!"})\n` +
      `🥩 Protein: *${log.protein || 0}g* / ${protTarget}g\n` +
      `🍽️ Meals logged: ${log.meals?.length || 0}\n` +
      `🏋️ Workout: ${log.workout ? "✅ Done!" : "❌ Not logged yet"}\n\n` +
      `${log.workout ? "Great consistency! 🔥" : "Don't forget your workout today! 💪"}`,
      { parse_mode: "Markdown" }
    );
    return;
  }

  if (text === "/stats") {
    const keys = Object.keys(user.logs).sort().slice(-7);
    if (keys.length === 0) {
      await bot.sendMessage(chatId, "No history yet. Start logging meals! 🍽️");
      return;
    }
    let statsMsg = "📅 *Last 7 Days*\n\n";
    for (const k of keys) {
      const l = user.logs[k];
      statsMsg += `${k}: *${l.calories || 0} kcal* | ${l.protein || 0}g protein | ${l.workout ? "✅" : "❌"} workout\n`;
    }
    await bot.sendMessage(chatId, statsMsg, { parse_mode: "Markdown" });
    return;
  }

  if (text === "/workout") {
    const log = getTodayLog(user);
    log.workout = true;
    saveData(data);
    await bot.sendMessage(chatId,
      `💪 *Workout logged!* Great work!\n\nConsistency is everything in recomposition. Every session counts.\n\n_Recovery tip: Make sure you're getting 7-9 hours of sleep and hitting your protein target today!_`,
      { parse_mode: "Markdown" }
    );
    return;
  }

  if (text === "/help") {
    await bot.sendMessage(chatId,
      `🔥 *FitBot Commands*\n\n` +
      `/today — Daily calorie & macro summary\n` +
      `/stats — Last 7 days history\n` +
      `/workout — Mark today's workout as done\n` +
      `/reset — Restart setup\n` +
      `/help — This menu\n\n` +
      `*You can also:*\n📸 Send a food photo → instant calorie analysis\n🎥 Send a workout video → form coaching\n💬 Chat naturally about nutrition & training`,
      { parse_mode: "Markdown" }
    );
    return;
  }

  if (text === "/reset") {
    user.setupStep = "name";
    user.profile   = {};
    user.history   = [];
    saveData(data);
    await bot.sendMessage(chatId, SETUP_PROMPTS.name, { parse_mode: "Markdown" });
    return;
  }

  // Setup flow
  if (user.setupStep && user.setupStep !== "done") {
    const handled = await handleSetup(chatId, user, text);
    saveData(data);
    if (handled) return;
  }

  // Photo handling
  let imageBase64 = null;
  let userText = text || "Analyze this";

  if (msg.photo) {
    const fileId   = msg.photo[msg.photo.length - 1].file_id;
    const fileInfo = await bot.getFile(fileId);
    const fileUrl  = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${fileInfo.file_path}`;
    imageBase64 = await downloadImage(fileUrl);
    userText = msg.caption || "Please analyze this food photo. Give me calories, protein, carbs, fats, and whether it fits my recomposition goal.";
    await bot.sendChatAction(chatId, "typing");
  } else if (msg.video || msg.video_note) {
    userText = `I just did a workout. ${text || "Can you give me form tips and coaching advice for this exercise?"}`;
    await bot.sendChatAction(chatId, "typing");
  } else if (text) {
    await bot.sendChatAction(chatId, "typing");
  } else {
    return;
  }

  // Detect workout completion from text
  if (/workout.*done|completed.*workout|finished.*(?:gym|training|lifting)|did.*(?:squats|deadlift|bench|pull.?ups|cardio|run|hiit)/i.test(userText)) {
    const log = getTodayLog(user);
    log.workout = true;
  }

  // Call Claude
  const todayLog = getTodayLog(user);
  try {
    const reply = await askClaude(user.profile, todayLog, user.history, userText, imageBase64);

    // Parse calories from reply and update log
    const calMatch  = reply.match(/(\d{2,4})\s*(?:kcal|calories|cal)\b/i);
    const protMatch = reply.match(/(\d{1,3})\s*g\s*protein/i);
    if (calMatch && (msg.photo || /ate|had|eating|breakfast|lunch|dinner|snack/i.test(userText))) {
      const cals = parseInt(calMatch[1]);
      const prot = protMatch ? parseInt(protMatch[1]) : 0;
      todayLog.calories = (todayLog.calories || 0) + cals;
      todayLog.protein  = (todayLog.protein  || 0) + prot;
      todayLog.meals.push({ time: new Date().toLocaleTimeString(), text: userText.substring(0, 60), calories: cals, protein: prot });
    }

    // Save history
    user.history.push({ role: "user", content: userText });
    user.history.push({ role: "assistant", content: reply });
    if (user.history.length > 30) user.history = user.history.slice(-30);

    saveData(data);
    await bot.sendMessage(chatId, reply, { parse_mode: "Markdown" });
  } catch (err) {
    console.error("Claude error:", err.message);
    await bot.sendMessage(chatId, "⚠️ Something went wrong. Try again in a moment!");
  }
});

// ── Scheduled reminders ──────────────────────────────────────────────────────
function sendReminders(hour, messageText) {
  schedule.scheduleJob(`0 ${hour} * * *`, async () => {
    const data = loadData();
    for (const chatId of Object.keys(data)) {
      const user = data[chatId];
      if (user.setupStep !== "done") continue;
      try {
        await bot.sendMessage(chatId, messageText, { parse_mode: "Markdown" });
      } catch (e) {
        console.error(`Reminder failed for ${chatId}:`, e.message);
      }
    }
  });
}

sendReminders(8,  "🌅 *Good morning!* Time to log your breakfast.\n\nSend me a 📸 photo of your meal or tell me what you ate!");
sendReminders(13, "☀️ *Lunch check-in!* What are you eating?\n\nSend a 📸 photo for instant calorie analysis!");
sendReminders(19, "🌙 *Dinner time!* Don't forget to log.\n\nAlso — did you complete your workout today? Type /workout to mark it done 💪");

// ── Start ────────────────────────────────────────────────────────────────────
console.log("🔥 FitBot is running...");
console.log("📅 Reminders scheduled at 8am, 1pm, 7pm");
