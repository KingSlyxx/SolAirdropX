// server.js — სრულად გამართული ვერსია (unisex ჩანს ორივე სქესში)

const express = require("express");
const bodyParser = require("body-parser");
const TelegramBot = require("node-telegram-bot-api");
const cors = require("cors");
const path = require("path");
const axios = require("axios");
const FormData = require("form-data");
const { Pool } = require("pg");

const app = express();
const port = process.env.PORT || 8080;

// --- გარემოს ცვლადები ---
const ADMIN_BOT_TOKEN = "8151755873:AAEBrslgbP49Q3FiTSKAm7fyQchNbUMVSe0";
const TELEGRAM_GROUP_ID = "-4644402426";
const IMGBB_API_KEY = process.env.IMGBB_API_KEY;
const DATABASE_URL = process.env.DATABASE_URL;

// --- PostgreSQL ---
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const initializeDatabase = async () => {
  try {
    const client = await pool.connect();
    console.log("✅ PostgreSQL connected");

    await client.query(`
      CREATE TABLE IF NOT EXISTS products (
        id SERIAL PRIMARY KEY,
        name_ge VARCHAR(255),
        name_en VARCHAR(255),
        price NUMERIC(10,2),
        old_price NUMERIC(10,2),
        description_ge TEXT,
        description_en TEXT,
        category VARCHAR(100),
        gender VARCHAR(50),
        sizes TEXT[],
        image_urls TEXT[],
        qc_image_urls TEXT[]
      );
    `);
    client.release();
  } catch (err) {
    console.error("❌ DB init error:", err);
    process.exit(1);
  }
};

app.use(cors());
app.use(express.static("public"));
app.use(bodyParser.json());

const userState = {};

const formatProductFromDb = (dbRow) => ({
  id: dbRow.id,
  name: { ge: dbRow.name_ge, en: dbRow.name_en },
  price: dbRow.price,
  oldPrice: dbRow.old_price,
  description: { ge: dbRow.description_ge, en: dbRow.description_en },
  category: dbRow.category,
  gender: dbRow.gender,
  sizes: dbRow.sizes || [],
  imageUrls: dbRow.image_urls || [],
  qcImageUrls: dbRow.qc_image_urls || [],
});

// ===== ADMIN BOT =====
let adminBot;
if (ADMIN_BOT_TOKEN) {
  adminBot = new TelegramBot(ADMIN_BOT_TOKEN, { polling: true });
  console.log("🤖 Admin Bot is running...");

  const mainMenuKeyboard = {
    keyboard: [
      [{ text: "პროდუქტების ნახვა" }],
      [{ text: "პროდუქტის დამატება" }],
    ],
    resize_keyboard: true,
  };

  const resetState = (chatId) => delete userState[chatId];

  const createEditKeyboard = (id) => ({
    inline_keyboard: [
      [
        { text: "სახელი (GE)", callback_data: `edit_name_ge_${id}` },
        { text: "სახელი (EN)", callback_data: `edit_name_en_${id}` },
      ],
      [
        { text: "ფასი", callback_data: `edit_price_${id}` },
        { text: "ძვ. ფასი", callback_data: `edit_old_price_${id}` },
      ],
      [
        { text: "აღწერა (GE)", callback_data: `edit_description_ge_${id}` },
        { text: "აღწერა (EN)", callback_data: `edit_description_en_${id}` },
      ],
      [
        { text: "კატეგორია", callback_data: `edit_category_${id}` },
        { text: "სქესი", callback_data: `edit_gender_${id}` },
      ],
      [{ text: "ზომები", callback_data: `edit_sizes_${id}` }],
      [{ text: "ფოტოები", callback_data: `edit_image_urls_${id}` }],
      [{ text: "QC ფოტოები", callback_data: `edit_qc_image_urls_${id}` }],
    ],
  });

  const fieldPrompts = {
    name_ge: "შეიყვანეთ ახალი სახელი (ქართულად):",
    name_en: "შეიყვანეთ ახალი სახელი (ინგლისურად):",
    price: "შეიყვანეთ ახალი ფასი:",
    old_price: "ძველი ფასი (თუ არაა, 0):",
    description_ge: "აღწერა ქართულად:",
    description_en: "აღწერა ინგლისურად:",
    category: "კატეგორია (მაგ: dresses):",
    gender: "სქესი (men, women, unisex):",
    sizes: "ზომები (მაგ: S,M,L):",
  };

  // ===== BOT COMMANDS =====
  adminBot.onText(/\/start/, (msg) => {
    resetState(msg.chat.id);
    adminBot.sendMessage(msg.chat.id, "აირჩიეთ მოქმედება:", {
      reply_markup: mainMenuKeyboard,
    });
  });

  // --- პროდუქტების ნახვა ---
  adminBot.onText(/პროდუქტების ნახვა/, async (msg) => {
    const chatId = msg.chat.id;
    const genderKeyboard = {
      inline_keyboard: [
        [
          { text: "♀️ ქალი", callback_data: "view_gender_women" },
          { text: "♂️ კაცი", callback_data: "view_gender_men" },
        ],
        [{ text: "🟣 Unisex", callback_data: "view_gender_unisex" }],
        [{ text: "ყველა", callback_data: "view_gender_all" }],
      ],
    };
    adminBot.sendMessage(chatId, "აირჩიეთ კატეგორია:", {
      reply_markup: genderKeyboard,
    });
  });

  // --- Callback query ---
  adminBot.on("callback_query", async (cb) => {
    const data = cb.data;
    const msg = cb.message;
    const chatId = msg.chat.id;

    const [action, , gender] = data.split("_");

    if (action === "view" && gender) {
      let query;
      let params = [];

      if (gender === "all") {
        query = "SELECT id, name_ge FROM products ORDER BY id ASC";
      } else if (gender === "unisex") {
        query =
          "SELECT id, name_ge FROM products WHERE gender = 'unisex' ORDER BY id ASC";
      } else {
        // 👇 აქ ხდება მთავარი — ირჩევა შესაბამისი სქესი ან unisex
        query =
          "SELECT id, name_ge FROM products WHERE gender = $1 OR gender = 'unisex' ORDER BY id ASC";
        params.push(gender);
      }

      const result = await pool.query(query, params);

      if (result.rows.length === 0) {
        await adminBot.editMessageText("პროდუქტები არ არის.", {
          chat_id: chatId,
          message_id: msg.message_id,
        });
        return;
      }

      let text = "პროდუქტების სია:\n\n";
      result.rows.forEach((p) => (text += `ID: ${p.id} | ${p.name_ge}\n`));
      text += "\nრედაქტირებისთვის ჩაწერეთ პროდუქტის ID.";

      await adminBot.editMessageText(text, {
        chat_id: chatId,
        message_id: msg.message_id,
      });
      userState[chatId] = { step: "awaiting_product_id" };
      await adminBot.answerCallbackQuery(cb.id);
    }
  });

  // --- მესიჯების დამუშავება ---
  adminBot.on("message", async (msg) => {
    const chatId = msg.chat.id;
    const state = userState[chatId];
    if (!state) return;

    try {
      // პროდუქტის დამატება
      if (!state.product) state.product = {};
      const p = state.product;

      switch (state.step) {
        case "awaiting_name_ge":
          p.name_ge = msg.text;
          state.step = "awaiting_name_en";
          return adminBot.sendMessage(chatId, "სახელი (ინგლისურად):");

        case "awaiting_name_en":
          p.name_en = msg.text;
          state.step = "awaiting_price";
          return adminBot.sendMessage(chatId, "ფასი:");

        case "awaiting_price":
          p.price = parseFloat(msg.text);
          state.step = "awaiting_gender";
          return adminBot.sendMessage(chatId, "სქესი (men/women/unisex):");

        case "awaiting_gender":
          p.gender = msg.text.trim().toLowerCase();
          state.step = "awaiting_category";
          return adminBot.sendMessage(chatId, "კატეგორია:");

        case "awaiting_category":
          p.category = msg.text.trim().toLowerCase();
          state.step = "awaiting_sizes";
          return adminBot.sendMessage(chatId, "ზომები (მაგ: S,M,L):");

        case "awaiting_sizes":
          p.sizes = msg.text.split(",").map((s) => s.trim().toUpperCase());
          state.step = "awaiting_description_ge";
          return adminBot.sendMessage(chatId, "აღწერა ქართულად:");

        case "awaiting_description_ge":
          p.description_ge = msg.text;
          state.step = "awaiting_description_en";
          return adminBot.sendMessage(chatId, "აღწერა ინგლისურად:");

        case "awaiting_description_en":
          p.description_en = msg.text;
          state.step = "awaiting_image_urls";
          return adminBot.sendMessage(
            chatId,
            "ფოტოები ატვირთეთ ან დაწერეთ 'done'."
          );

        case "awaiting_image_urls":
          if (msg.text.toLowerCase() === "done") {
            // პროდუქტის შენახვა
            await pool.query(
              `INSERT INTO products 
              (name_ge, name_en, price, description_ge, description_en, category, gender, sizes, image_urls)
              VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
              [
                p.name_ge,
                p.name_en,
                p.price,
                p.description_ge,
                p.description_en,
                p.category,
                p.gender,
                p.sizes,
                p.imageUrls || [],
              ]
            );
            resetState(chatId);
            return adminBot.sendMessage(chatId, "✅ პროდუქტი დაემატა!", {
              reply_markup: mainMenuKeyboard,
            });
          }
          break;
      }
    } catch (e) {
      console.error("Message error:", e);
      adminBot.sendMessage(chatId, `შეცდომა: ${e.message}`);
      resetState(chatId);
    }
  });
}

// ===== API =====
app.get("/api/products", async (req, res) => {
  const result = await pool.query("SELECT * FROM products ORDER BY id DESC");
  res.json(result.rows.map(formatProductFromDb));
});

app.get("/api/products/:gender", async (req, res) => {
  const gender = req.params.gender.toLowerCase();

  let query, params;
  if (gender === "all") {
    query = "SELECT * FROM products ORDER BY id DESC";
    params = [];
  } else if (gender === "unisex") {
    query = "SELECT * FROM products WHERE gender = 'unisex' ORDER BY id DESC";
    params = [];
  } else {
    // 👇 აქაც იგივე ლოგიკა — აჩვენე შესაბამისი სქესი ან unisex
    query =
      "SELECT * FROM products WHERE gender = $1 OR gender = 'unisex' ORDER BY id DESC";
    params = [gender];
  }

  const result = await pool.query(query, params);
  res.json(result.rows.map(formatProductFromDb));
});

// ===== START SERVER =====
app.listen(port, async () => {
  await initializeDatabase();
  console.log(`🚀 Server running on port ${port}`);
});