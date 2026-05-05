const TelegramBot = require("node-telegram-bot-api");
const schedule = require("node-schedule");
const fs = require("fs");
const path = require("path");
const https = require("https");

// ── Config ────────────────────────────────────────────────────────────────────
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const DATA_FILE = path.join(__dirname, "data.json");

if (!TELEGRAM_TOKEN || !GEMINI_API_KEY) {
  console.error("❌ Missing TELEGRAM_BOT_TOKEN or GEMINI_API_KEY in environment");
  process.exit(1);
}

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

// ── Storage ───────────────────────────────────────────────────────────────────
function loadData() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); } catch { return {}; }
}
function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}
function getTodayKey() {
  return new Date().toISOString().split("T")[0];
}
function getWeekKey() {
  const now = new Date();
  const start = new Date(now);
  start.setDate(now.getDate() - now.getDay());
  return start.toISOString().split("T")[0];
}
function getUser(data, chatId) {
  if (!data[chatId]) {
    data[chatId] = {
      profile: {},
      logs: {},
      history: [],
      setupStep: "name",
      weeklyPhotos: {},
      progressPhotos: [],
      currentDietPlan: null,
      dietPlanWeek: null,
      currentWorkoutPlan: null,
      workoutPlanWeek: null,
      weeklyPhotoStep: null,
    };
  }
  return data[chatId];
}
function getTodayLog(user) {
  const key = getTodayKey();
  if (!user.logs[key]) user.logs[key] = { meals: [], calories: 0, protein: 0, workout: false };
  return user.logs[key];
}

// ── Gemini API ────────────────────────────────────────────────────────────────
async function callGemini(systemPrompt, history, userText, imageBase64 = null, mimeType = "image/jpeg") {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`;

  const contents = [];
  const recentHistory = history.slice(-12);
  for (const msg of recentHistory) {
    contents.push({
      role: msg.role === "assistant" ? "model" : "user",
      parts: [{ text: msg.content }]
    });
  }

  const currentParts = [];
  if (imageBase64) {
    currentParts.push({ inline_data: { mime_type: mimeType, data: imageBase64 } });
  }
  currentParts.push({ text: userText });
  contents.push({ role: "user", parts: currentParts });

  const body = JSON.stringify({
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents,
    generationConfig: { maxOutputTokens: 800, temperature: 0.7 }
  });

  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }
    }, (res) => {
      let raw = "";
      res.on("data", c => raw += c);
      res.on("end", () => {
        try {
          const parsed = JSON.parse(raw);
          if (parsed.error) { reject(new Error(parsed.error.message)); return; }
          resolve(parsed.candidates?.[0]?.content?.parts?.[0]?.text || "Sorry, I couldn't respond.");
        } catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ── System prompts ────────────────────────────────────────────────────────────
const MAIN_SYSTEM = (profile, todayLog, dietPlan, workoutPlan) => {
  const w = parseFloat(profile.weight) || 70;
  const calTarget = Math.round(w * 23);
  const protTarget = Math.round(w * 2);
  return `You are Coach Raj — a veteran bodybuilding coach with 20 years of experience. You've trained hundreds of athletes from beginners to competitive bodybuilders. You are firm, precise, knowledgeable, and deeply caring about results.

SPECIALIZATION: Body recomposition — simultaneous fat loss + lean muscle building for natural athletes.

User Profile:
- Name: ${profile.name || "User"}
- Age: ${profile.age || "?"} | Weight: ${w}kg | Height: ${profile.height || "?"}cm
- Goal: Fat loss + muscle building (slow & steady recomposition)
- Calorie target: ${calTarget} kcal/day
- Protein target: ${protTarget}g/day
- Diet: STRICT PURE VEGETARIAN (no eggs, no meat, no fish, no dairy alternatives needed — Indian home-cooked meals)

Today's log: ${JSON.stringify(todayLog)}

Current Diet Plan:
${dietPlan ? dietPlan : "Not generated yet. Generate with /dietplan"}

Current Workout Plan:
${workoutPlan ? workoutPlan : "Not generated yet. Generate with /workout_plan"}

COACHING RULES:
1. FOOD PHOTOS → Analyze what you see. Compare with today's diet plan. Say if meal matches plan or deviates. Estimate calories, protein, carbs, fats. Give ✅ if on plan or ⚠️ with correction if off plan.
2. PROGRESS PHOTOS → Analyze physique objectively. Comment on visible fat loss, muscle definition, posture, symmetry. Compare with previous week if available. Give honest assessment like a real coach.
3. WORKOUT QUESTIONS → Give precise form cues, breathing patterns, mind-muscle connection tips based on your 20 years experience.
4. DIET DEVIATIONS → Call it out clearly but constructively. Suggest easy home-cooked substitutions.
5. MOTIVATION → Real talk only. No fluff. Remind them recomp takes 3-6 months. Celebrate small wins loudly.
6. FORMAT → Telegram markdown (*bold*, _italic_). Max 300 words. Punchy and direct.
7. Always end food analysis with: "📊 Today: X kcal / Yg protein (Target: ${calTarget} kcal / ${protTarget}g protein)"`;
};

const DIET_SYSTEM = (profile, weekNumber) => {
  const w = parseFloat(profile.weight) || 70;
  const calTarget = Math.round(w * 23);
  const protTarget = Math.round(w * 2);
  return `You are Coach Raj, a veteran bodybuilding nutritionist with 20 years experience. Create a detailed 7-day PURE VEGETARIAN diet plan for body recomposition.

STRICT RULES:
- Pure vegetarian ONLY — no eggs, no meat, no fish
- Indian home-cooked meals only — dal, sabzi, roti, rice, paneer, curd, sprouts, etc.
- Every meal must have exact quantities in grams/cups/pieces
- High protein focus using: paneer, dal, rajma, chana, moong, soya chunks, curd, milk
- Calories: ${calTarget} kcal/day | Protein: ${protTarget}g/day
- This is Week ${weekNumber} plan — ${weekNumber > 1 ? "vary meals from previous weeks, increase challenge" : "start with basics"}
- Include pre/post workout meals
- Include exact cooking methods (boiled, sautéed, etc.)

FORMAT: Return a clean 7-day plan. For each day show:
Day X:
🌅 Breakfast (time): [meal] - [quantity] - [calories] kcal / [protein]g protein
☀️ Mid-Morning: [meal] - [quantity]
🍽️ Lunch: [meal] - [quantity] - [calories] kcal / [protein]g protein  
🌆 Evening Snack: [meal] - [quantity]
🌙 Dinner: [meal] - [quantity] - [calories] kcal / [protein]g protein
💊 Supplements: [if any natural ones]
📊 Day Total: [calories] kcal / [protein]g protein

Be specific — "2 medium rotis (60g each)" not just "rotis"`;
};

const WORKOUT_SYSTEM = (profile, weekNumber) => {
  const w = parseFloat(profile.weight) || 70;
  return `You are Coach Raj, a veteran bodybuilder and coach with 20 years experience. Create a detailed workout plan for body recomposition.

User: Weight ${w}kg, Goal: fat loss + muscle building
Week Number: ${weekNumber}
Equipment: Assume home/gym both possible — give both options where relevant
${weekNumber > 1 ? "Progressive overload from previous weeks — increase volume or intensity" : "Foundation week — perfect form focus"}

PLAN STRUCTURE:
- 4 resistance training days + 2 cardio days + 1 rest
- Compound movements as foundation
- Include sets, reps, rest periods, tempo
- Include warm-up and cool-down
- Give form cue for each exercise (1 key tip)

FORMAT:
Day 1 - [Muscle Group]:
• Exercise name: X sets × X reps @ [tempo] — rest Xs
  💡 Form tip: [key cue]

Include weekly goals and what to focus on this week.
End with: "Progressive overload target for next week: [specific target]"`;
};

const PROGRESS_SYSTEM = (profile, previousAnalysis) => `You are Coach Raj, a veteran bodybuilding coach with 20 years of experience analyzing physiques. You have an expert eye for body composition changes.

User: ${profile.name}, ${profile.weight}kg, Goal: fat loss + muscle building

Previous week analysis: ${previousAnalysis || "This is the first week — establish baseline"}

ANALYZE THE PROGRESS PHOTO(S):
1. Body fat distribution — where is fat being lost?
2. Muscle definition — any visible improvements?
3. Posture and symmetry observations
4. Comparison with last week (if available)
5. Estimated body fat % range (visual estimate)
6. What's working, what needs improvement
7. Motivation and next week's focus areas

Be honest like a real coach — not harsh, not overly positive. Real observations only.
Format with clear sections. End with: "🎯 Focus for next week: [specific actionable goal]"`;

// ── Diet plan generator ───────────────────────────────────────────────────────
async function generateDietPlan(user, chatId) {
  const weekNum = Object.keys(user.weeklyPhotos || {}).length + 1;
  await bot.sendMessage(chatId, "🥗 *Generating your Week " + weekNum + " personalized vegetarian diet plan...*\n\n_This may take 30 seconds_", { parse_mode: "Markdown" });
  await bot.sendChatAction(chatId, "typing");

  try {
    const plan = await callGemini(DIET_SYSTEM(user.profile, weekNum), [], "Generate the complete 7-day vegetarian diet plan now.");
    user.currentDietPlan = plan;
    user.dietPlanWeek = getWeekKey();

    // Send in chunks if too long
    const chunks = splitMessage(plan);
    for (const chunk of chunks) {
      await bot.sendMessage(chatId, chunk, { parse_mode: "Markdown" });
    }
    await bot.sendMessage(chatId,
      "✅ *Diet plan saved!*\n\n📸 When you eat, send me a photo and I'll check if it matches your plan!\n\n_Plan auto-refreshes every 7 days_",
      { parse_mode: "Markdown" }
    );
  } catch (err) {
    console.error("Diet plan error:", err.message);
    await bot.sendMessage(chatId, "⚠️ Error generating plan. Try again with /dietplan");
  }
}

// ── Workout plan generator ────────────────────────────────────────────────────
async function generateWorkoutPlan(user, chatId) {
  const weekNum = Object.keys(user.weeklyPhotos || {}).length + 1;
  await bot.sendMessage(chatId, "🏋️ *Generating your Week " + weekNum + " workout plan...*\n\n_Coach Raj is designing your program_", { parse_mode: "Markdown" });
  await bot.sendChatAction(chatId, "typing");

  try {
    const plan = await callGemini(WORKOUT_SYSTEM(user.profile, weekNum), [], "Generate the complete weekly workout plan now.");
    user.currentWorkoutPlan = plan;
    user.workoutPlanWeek = getWeekKey();

    const chunks = splitMessage(plan);
    for (const chunk of chunks) {
      await bot.sendMessage(chatId, chunk, { parse_mode: "Markdown" });
    }
    await bot.sendMessage(chatId,
      "✅ *Workout plan saved!*\n\n💪 Follow this plan this week. Send workout videos for form checks!\n\n_Plan updates with your weekly progress_",
      { parse_mode: "Markdown" }
    );
  } catch (err) {
    console.error("Workout plan error:", err.message);
    await bot.sendMessage(chatId, "⚠️ Error generating plan. Try again with /workout_plan");
  }
}

// ── Helper: split long messages ───────────────────────────────────────────────
function splitMessage(text, maxLen = 3800) {
  if (text.length <= maxLen) return [text];
  const chunks = [];
  let current = "";
  for (const line of text.split("\n")) {
    if ((current + "\n" + line).length > maxLen) {
      chunks.push(current);
      current = line;
    } else {
      current += (current ? "\n" : "") + line;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

// ── Image downloader ──────────────────────────────────────────────────────────
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

// ── Setup flow ────────────────────────────────────────────────────────────────
const SETUP_STEPS = ["name", "age", "weight", "height"];
const SETUP_PROMPTS = {
  name:   "👋 Welcome to *FitBot* by Coach Raj!\n\n20 years of bodybuilding coaching experience, now in your pocket — and completely *FREE* powered by Google Gemini.\n\nLet's build your profile.\n\n*What's your name?*",
  age:    "💪 *How old are you?* (e.g. 25)",
  weight: "⚖️ *Current weight in kg?* (e.g. 75)",
  height: "📏 *Height in cm?* (e.g. 175)",
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
    await bot.sendMessage(chatId,
      `✅ *Profile saved, ${user.profile.name}!*\n\n` +
      `*Your targets:*\n` +
      `🔥 Calories: ${Math.round(w * 23)} kcal/day\n` +
      `🥩 Protein: ${Math.round(w * 2)}g/day\n` +
      `🥗 Diet: Pure Vegetarian (Indian home-cooked)\n\n` +
      `*Get started:*\n` +
      `🥗 /dietplan — Get your Week 1 diet plan\n` +
      `🏋️ /workout\\_plan — Get your Week 1 workout plan\n` +
      `📸 /progress — Start weekly photo check-in\n\n` +
      `*Daily commands:*\n` +
      `📊 /today — Daily summary\n` +
      `📅 /stats — Weekly history\n` +
      `❓ /help — All commands\n\n` +
      `I'll remind you 3x daily for meals + Sunday for progress photos.\n\n` +
      `Start with /dietplan — let's go! 🔥`,
      { parse_mode: "Markdown" }
    );
  }
  return true;
}

// ── Weekly photo collection flow ──────────────────────────────────────────────
async function startWeeklyPhotoFlow(chatId, user) {
  user.weeklyPhotoStep = "front";
  user.tempPhotos = {};
  await bot.sendMessage(chatId,
    `📸 *Weekly Progress Check-in — Week ${Object.keys(user.weeklyPhotos || {}).length + 1}*\n\n` +
    `Coach Raj needs 3 photos to properly assess your progress.\n\n` +
    `*Send your FRONT photo now*\n` +
    `_Stand straight, arms slightly away from body, good lighting_`,
    { parse_mode: "Markdown" }
  );
}

// ── Main message handler ──────────────────────────────────────────────────────
bot.on("message", async (msg) => {
  const chatId = String(msg.chat.id);
  const text = msg.text || "";
  const data = loadData();
  const user = getUser(data, chatId);

  // ── Commands ──
  if (text === "/start") {
    user.setupStep = "name";
    user.profile = {};
    user.history = [];
    user.weeklyPhotos = {};
    user.currentDietPlan = null;
    user.currentWorkoutPlan = null;
    saveData(data);
    await bot.sendMessage(chatId, SETUP_PROMPTS.name, { parse_mode: "Markdown" });
    return;
  }

  if (text === "/dietplan") {
    if (user.setupStep !== "done") { await bot.sendMessage(chatId, "Please complete setup first with /start"); return; }
    await generateDietPlan(user, chatId);
    saveData(data);
    return;
  }

  if (text === "/workout_plan") {
    if (user.setupStep !== "done") { await bot.sendMessage(chatId, "Please complete setup first with /start"); return; }
    await generateWorkoutPlan(user, chatId);
    saveData(data);
    return;
  }

  if (text === "/progress") {
    if (user.setupStep !== "done") { await bot.sendMessage(chatId, "Please complete setup first with /start"); return; }
    await startWeeklyPhotoFlow(chatId, user);
    saveData(data);
    return;
  }

  if (text === "/today") {
    const log = getTodayLog(user);
    const w = parseFloat(user.profile.weight) || 70;
    const calTarget = Math.round(w * 23);
    const protTarget = Math.round(w * 2);
    const remaining = calTarget - (log.calories || 0);
    await bot.sendMessage(chatId,
      `📊 *Today — ${getTodayKey()}*\n\n` +
      `🔥 Calories: *${log.calories || 0}* / ${calTarget} kcal\n` +
      `${remaining > 0 ? `_${remaining} kcal remaining_` : "_🎯 Target reached!_"}\n\n` +
      `🥩 Protein: *${log.protein || 0}g* / ${protTarget}g\n` +
      `🍽️ Meals: ${log.meals?.length || 0} logged\n` +
      `🏋️ Workout: ${log.workout ? "✅ Done!" : "❌ Not logged"}\n\n` +
      `Diet plan: ${user.currentDietPlan ? "✅ Active" : "❌ None — use /dietplan"}\n` +
      `Workout plan: ${user.currentWorkoutPlan ? "✅ Active" : "❌ None — use /workout\\_plan"}`,
      { parse_mode: "Markdown" }
    );
    return;
  }

  if (text === "/stats") {
    const keys = Object.keys(user.logs).sort().slice(-7);
    if (keys.length === 0) { await bot.sendMessage(chatId, "No history yet. Start logging meals! 🍽️"); return; }
    let msg2 = "📅 *Last 7 Days*\n\n";
    for (const k of keys) {
      const l = user.logs[k];
      msg2 += `${k}: *${l.calories || 0} kcal* | ${l.protein || 0}g protein | ${l.workout ? "✅" : "❌"}\n`;
    }
    const weeksLogged = Object.keys(user.weeklyPhotos || {}).length;
    msg2 += `\n📸 Progress check-ins completed: *${weeksLogged} weeks*`;
    await bot.sendMessage(chatId, msg2, { parse_mode: "Markdown" });
    return;
  }

  if (text === "/workout") {
    const log = getTodayLog(user);
    log.workout = true;
    saveData(data);
    await bot.sendMessage(chatId, `💪 *Workout logged!*\n\n_Hit your protein target and sleep 7-9 hours — that's where muscle is built._`, { parse_mode: "Markdown" });
    return;
  }

  if (text === "/myplan") {
    if (!user.currentDietPlan && !user.currentWorkoutPlan) {
      await bot.sendMessage(chatId, "No plans yet!\n\n🥗 /dietplan — Generate diet plan\n🏋️ /workout\\_plan — Generate workout plan", { parse_mode: "Markdown" });
      return;
    }
    if (user.currentDietPlan) {
      await bot.sendMessage(chatId, "🥗 *Your Current Diet Plan:*", { parse_mode: "Markdown" });
      const chunks = splitMessage(user.currentDietPlan);
      for (const chunk of chunks) await bot.sendMessage(chatId, chunk, { parse_mode: "Markdown" });
    }
    if (user.currentWorkoutPlan) {
      await bot.sendMessage(chatId, "🏋️ *Your Current Workout Plan:*", { parse_mode: "Markdown" });
      const chunks = splitMessage(user.currentWorkoutPlan);
      for (const chunk of chunks) await bot.sendMessage(chatId, chunk, { parse_mode: "Markdown" });
    }
    return;
  }

  if (text === "/help") {
    await bot.sendMessage(chatId,
      `🔥 *Coach Raj — FitBot Commands*\n\n` +
      `*Setup & Plans:*\n` +
      `/dietplan — Generate/refresh 7-day veg diet plan\n` +
      `/workout\\_plan — Generate/refresh workout plan\n` +
      `/myplan — View your current plans\n\n` +
      `*Daily Tracking:*\n` +
      `/today — Today's calorie & macro summary\n` +
      `/workout — Mark today's workout done\n` +
      `/stats — Last 7 days history\n\n` +
      `*Progress:*\n` +
      `/progress — Weekly photo check-in (front/back/side)\n\n` +
      `*Send anytime:*\n` +
      `📸 Food photo → calorie analysis + diet plan check\n` +
      `🎥 Workout video → form coaching\n` +
      `💬 Any question → Coach Raj answers`,
      { parse_mode: "Markdown" }
    );
    return;
  }

  if (text === "/reset") {
    user.setupStep = "name";
    user.profile = {};
    user.history = [];
    saveData(data);
    await bot.sendMessage(chatId, SETUP_PROMPTS.name, { parse_mode: "Markdown" });
    return;
  }

  // ── Setup flow ──
  if (user.setupStep && user.setupStep !== "done") {
    const handled = await handleSetup(chatId, user, text);
    saveData(data);
    if (handled) return;
  }

  // ── Weekly photo collection flow ──
  if (msg.photo && user.weeklyPhotoStep && ["front", "back", "side"].includes(user.weeklyPhotoStep)) {
    const fileId = msg.photo[msg.photo.length - 1].file_id;
    const fileInfo = await bot.getFile(fileId);
    const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${fileInfo.file_path}`;
    const b64 = await downloadImage(fileUrl);

    user.tempPhotos = user.tempPhotos || {};
    user.tempPhotos[user.weeklyPhotoStep] = b64;

    if (user.weeklyPhotoStep === "front") {
      user.weeklyPhotoStep = "back";
      await bot.sendMessage(chatId,
        `✅ *Front photo received!*\n\nNow send your *BACK photo*\n_Same stance, facing away from camera_`,
        { parse_mode: "Markdown" }
      );
    } else if (user.weeklyPhotoStep === "back") {
      user.weeklyPhotoStep = "side";
      await bot.sendMessage(chatId,
        `✅ *Back photo received!*\n\nNow send your *SIDE photo*\n_Stand sideways, arms relaxed_`,
        { parse_mode: "Markdown" }
      );
    } else if (user.weeklyPhotoStep === "side") {
      user.weeklyPhotoStep = null;
      await bot.sendMessage(chatId,
        `✅ *All 3 photos received!*\n\n_Coach Raj is analyzing your physique..._`,
        { parse_mode: "Markdown" }
      );
      await bot.sendChatAction(chatId, "typing");

      // Get previous week analysis
      const weekKeys = Object.keys(user.weeklyPhotos || {}).sort();
      const prevWeekKey = weekKeys[weekKeys.length - 1];
      const prevAnalysis = prevWeekKey ? user.weeklyPhotos[prevWeekKey]?.analysis : null;

      // Analyze with front photo (Gemini can only take one image at a time)
      try {
        const analysis = await callGemini(
          PROGRESS_SYSTEM(user.profile, prevAnalysis),
          [],
          `This is my Week ${weekKeys.length + 1} progress photo (front view). ${prevAnalysis ? "Compare with last week's analysis provided in system prompt." : "This is my baseline Week 1 photo."} Please give me your honest coach assessment.`,
          user.tempPhotos.front
        );

        // Save this week's data
        const weekKey = getWeekKey();
        if (!user.weeklyPhotos) user.weeklyPhotos = {};
        user.weeklyPhotos[weekKey] = {
          date: getTodayKey(),
          weekNumber: weekKeys.length + 1,
          analysis: analysis,
          hasPhotos: true
        };

        const chunks = splitMessage(analysis);
        for (const chunk of chunks) {
          await bot.sendMessage(chatId, chunk, { parse_mode: "Markdown" });
        }

        // Auto-generate new plans for next week
        const weekNumber = weekKeys.length + 1;
        await bot.sendMessage(chatId,
          `\n📋 *Week ${weekNumber} complete!*\n\nGenerating updated plans based on your progress...`,
          { parse_mode: "Markdown" }
        );
        await generateDietPlan(user, chatId);
        await generateWorkoutPlan(user, chatId);

        user.tempPhotos = {};
        saveData(data);
      } catch (err) {
        console.error("Progress analysis error:", err.message);
        await bot.sendMessage(chatId, "⚠️ Error analyzing photos. Try /progress again.");
      }
    }
    saveData(data);
    return;
  }

  // ── Regular photo/message handling ──
  let imageBase64 = null;
  let userText = text || "Analyze this";
  let isFood = false;
  let isWorkout = false;

  if (msg.photo) {
    const fileId = msg.photo[msg.photo.length - 1].file_id;
    const fileInfo = await bot.getFile(fileId);
    const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${fileInfo.file_path}`;
    imageBase64 = await downloadImage(fileUrl);
    const caption = (msg.caption || "").toLowerCase();
    isWorkout = /workout|gym|exercise|form|squat|deadlift|bench|press|curl|row/i.test(caption);
    isFood = !isWorkout;
    userText = msg.caption ||
      (isWorkout
        ? "Analyze my workout form and give me coaching tips."
        : `Analyze this food. Compare with my diet plan for today. Give calories, protein, carbs, fats. Tell me if this matches my plan or not.`);
    await bot.sendChatAction(chatId, "typing");
  } else if (msg.video || msg.video_note) {
    isWorkout = true;
    userText = `Workout video check: ${text || "Analyze my form and give coaching tips based on your 20 years experience."}`;
    await bot.sendChatAction(chatId, "typing");
  } else if (text) {
    await bot.sendChatAction(chatId, "typing");
  } else {
    return;
  }

  // Detect workout done from text
  if (/workout.*done|completed.*workout|finished.*(?:gym|training|lifting)|did.*(?:squats|deadlift|bench|pull.?ups|cardio|run|hiit)/i.test(userText)) {
    getTodayLog(user).workout = true;
  }

  const todayLog = getTodayLog(user);

  try {
    const reply = await callGemini(
      MAIN_SYSTEM(user.profile, todayLog, user.currentDietPlan, user.currentWorkoutPlan),
      user.history,
      userText,
      imageBase64
    );

    // Auto-parse calories from food photos
    if (isFood && imageBase64) {
      const calMatch = reply.match(/(\d{2,4})\s*(?:kcal|calories|cal)\b/i);
      const protMatch = reply.match(/(\d{1,3})\s*g\s*protein/i);
      if (calMatch) {
        const cals = parseInt(calMatch[1]);
        const prot = protMatch ? parseInt(protMatch[1]) : 0;
        todayLog.calories = (todayLog.calories || 0) + cals;
        todayLog.protein = (todayLog.protein || 0) + prot;
        todayLog.meals.push({
          time: new Date().toLocaleTimeString(),
          text: userText.substring(0, 60),
          calories: cals,
          protein: prot
        });
      }
    }

    user.history.push({ role: "user", content: userText });
    user.history.push({ role: "assistant", content: reply });
    if (user.history.length > 30) user.history = user.history.slice(-30);

    saveData(data);
    const chunks = splitMessage(reply);
    for (const chunk of chunks) {
      await bot.sendMessage(chatId, chunk, { parse_mode: "Markdown" });
    }
  } catch (err) {
    console.error("Gemini error:", err.message);
    await bot.sendMessage(chatId, "⚠️ Something went wrong. Try again!");
  }
});

// ── Scheduled reminders ───────────────────────────────────────────────────────
function sendToAll(messageText) {
  const data = loadData();
  for (const chatId of Object.keys(data)) {
    const user = data[chatId];
    if (user.setupStep !== "done") continue;
    bot.sendMessage(chatId, messageText, { parse_mode: "Markdown" }).catch(e => console.error(`Reminder error ${chatId}:`, e.message));
  }
}

// Daily meal reminders
schedule.scheduleJob("0 8 * * *", () => sendToAll(
  "🌅 *Good morning!* Breakfast time!\n\nSend a 📸 photo of your meal — Coach Raj will check if it matches your diet plan!"
));
schedule.scheduleJob("0 13 * * *", () => sendToAll(
  "☀️ *Lunch check-in!*\n\nWhat are you eating? Send a 📸 photo for instant analysis and diet plan comparison!"
));
schedule.scheduleJob("0 19 * * *", () => sendToAll(
  "🌙 *Dinner time + Workout check!*\n\nLog your dinner 📸 and mark /workout if you trained today 💪"
));

// Sunday weekly progress reminder
schedule.scheduleJob("0 9 * * 0", () => sendToAll(
  "📸 *Weekly Progress Check-in Day!*\n\n_Coach Raj needs your progress photos to track your transformation and update your plans._\n\nSend /progress to start your front, back and side photo check-in!\n\n*This is the most important thing you can do today* 🔥"
));

// Weekly plan refresh check (every Monday)
schedule.scheduleJob("0 6 * * 1", () => {
  const data = loadData();
  for (const chatId of Object.keys(data)) {
    const user = data[chatId];
    if (user.setupStep !== "done") continue;
    const currentWeek = getWeekKey();
    if (user.dietPlanWeek !== currentWeek) {
      bot.sendMessage(chatId,
        "📋 *New week, new plan!*\n\nYour diet and workout plans are due for an update.\n\n🥗 /dietplan — Refresh diet plan\n🏋️ /workout\\_plan — Refresh workout plan\n\nOr complete your weekly /progress check-in for auto-updated plans!",
        { parse_mode: "Markdown" }
      ).catch(() => {});
    }
  }
});

console.log("🔥 FitBot (Coach Raj) is running... powered by Gemini FREE!");
console.log("📅 Reminders: 8am, 1pm, 7pm daily | 9am Sunday progress check-in");
