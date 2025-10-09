// server.js (სრული ვერსია – gender/unisex გასწორებული ლოგიკით)

const express = require('express');
const bodyParser = require('body-parser');
const TelegramBot = require('node-telegram-bot-api');
const cors = require('cors');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');
const { Pool } = require('pg');

const app = express();
const port = process.env.PORT || 8080;

// --- გარემოს ცვლადები ---
const ADMIN_BOT_TOKEN = '8151755873:AAEBrslgbP49Q3FiTSKAm7fyQchNbUMVSe0';
const TELEGRAM_CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID;
const TELEGRAM_GROUP_ID = '-4644402426';
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
    console.log('Successfully connected to PostgreSQL database.');

    await client.query(`
      CREATE TABLE IF NOT EXISTS products (
        id SERIAL PRIMARY KEY,
        name_ge VARCHAR(255) NOT NULL,
        name_en VARCHAR(255) NOT NULL,
        price NUMERIC(10, 2) NOT NULL,
        old_price NUMERIC(10, 2),
        description_ge TEXT,
        description_en TEXT,
        category VARCHAR(100),
        gender VARCHAR(50),
        sizes TEXT[],
        image_urls TEXT[],
        qc_image_urls TEXT[]
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS orders (
        order_id VARCHAR(20) PRIMARY KEY,
        customer_data JSONB,
        items JSONB,
        total_price NUMERIC(10, 2),
        status VARCHAR(50) DEFAULT 'მიღებულია',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    console.log('Database tables are ready.');
    client.release();
  } catch (err) {
    console.error('Database init error:', err);
    process.exit(1);
  }
};

app.use(cors());
app.use(express.static('public'));
app.use(bodyParser.json());
app.set('trust proxy', true);

const userState = {};
const chatSessions = new Map();

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
  console.log('Admin Bot is running...');

  const mainMenuKeyboard = {
    keyboard: [[{ text: 'პროდუქტების ნახვა' }], [{ text: 'პროდუქტის დამატება' }]],
    resize_keyboard: true,
  };

  const resetState = (chatId) => delete userState[chatId];

  const createEditKeyboard = (productId) => ({
    inline_keyboard: [
      [{ text: 'სახელი (GE)', callback_data: `edit_name_ge_${productId}` }, { text: 'სახელი (EN)', callback_data: `edit_name_en_${productId}` }],
      [{ text: 'ფასი', callback_data: `edit_price_${productId}` }, { text: 'ძვ. ფასი', callback_data: `edit_old_price_${productId}` }],
      [{ text: 'აღწერა (GE)', callback_data: `edit_description_ge_${productId}` }, { text: 'აღწერა (EN)', callback_data: `edit_description_en_${productId}` }],
      [{ text: 'კატეგორია', callback_data: `edit_category_${productId}` }, { text: 'სქესი', callback_data: `edit_gender_${productId}` }],
      [{ text: 'ზომები', callback_data: `edit_sizes_${productId}` }],
      [{ text: 'ძირითადი ფოტოები', callback_data: `edit_image_urls_${productId}` }],
      [{ text: 'QC ფოტოები', callback_data: `edit_qc_image_urls_${productId}` }],
      [{ text: '◀ უკან', callback_data: `back_to_products` }]
    ]
  });

  const fieldPrompts = {
    name_ge: 'შეიყვანეთ ახალი სახელი (ქართულად):',
    name_en: 'შეიყვანეთ ახალი სახელი (ინგლისურად):',
    price: 'შეიყვანეთ ახალი ფასი (მაგ: 129.99):',
    old_price: 'შეიყვანეთ ახალი ძველი ფასი (თუ არ აქვს, დაწერეთ 0):',
    description_ge: 'შეიყვანეთ ახალი აღწერა (ქართულად):',
    description_en: 'შეიყვანეთ ახალი აღწერა (ინგლისურად):',
    category: 'შეიყვანეთ ახალი კატეგორია (მაგ: dresses):',
    gender: 'მიუთითეთ ახალი სქესი (women, men ან unisex):',
    sizes: 'შეიყვანეთ ახალი ზომები მძიმით გამოყოფით (მაგ: S,M,L):',
    image_urls: "ატვირთეთ ახალი ძირითადი ფოტო(ები). დასრულებისას დაწერეთ 'done'.",
    qc_image_urls: "ატვირთეთ ახალი QC ფოტო(ები). დასრულებისას დაწერეთ 'done'."
  };

  // ====== BOT COMMANDS ======

  adminBot.onText(/\/start/, (msg) => {
    resetState(msg.chat.id);
    adminBot.sendMessage(msg.chat.id, 'მოგესალმებით! აირჩიეთ მოქმედება:', { reply_markup: mainMenuKeyboard });
  });

  adminBot.onText(/პროდუქტების ნახვა/, async (msg) => {
    const chatId = msg.chat.id;
    const genderSelectionKeyboard = {
      inline_keyboard: [
        [{ text: '♀️ ქალი', callback_data: 'view_gender_women' }, { text: '♂️ კაცი', callback_data: 'view_gender_men' }],
        [{ text: '🟣 Unisex', callback_data: 'view_gender_unisex' }],
        [{ text: 'ყველას ნახვა', callback_data: 'view_gender_all' }]
      ]
    };
    await adminBot.sendMessage(chatId, "აირჩიეთ კატეგორია პროდუქტების სანახავად:", { reply_markup: genderSelectionKeyboard });
  });

  // ====== CALLBACK QUERY ======
  adminBot.on('callback_query', async (callbackQuery) => {
    const msg = callbackQuery.message;
    const data = callbackQuery.data;
    const chatId = msg.chat.id;
    const [action, ...params] = data.split('_');

    try {
      // ----- ნახვა -----
      if (action === 'view' && params[0] === 'gender') {
        const gender = params[1];
        let query = 'SELECT id, name_ge FROM products';
        const queryParams = [];

        if (gender !== 'all') {
          query += ' WHERE gender = $1';
          queryParams.push(gender.toLowerCase());
        }

        query += ' ORDER BY id ASC';
        const result = await pool.query(query, queryParams);

        if (result.rows.length === 0) {
          await adminBot.editMessageText("ამ კატეგორიაში პროდუქტები არ არის.", { chat_id: chatId, message_id: msg.message_id });
          return;
        }

        let productList = "პროდუქტების სია:\n\n";
        result.rows.forEach(p => productList += `ID: ${p.id} | ${p.name_ge}\n`);
        productList += "\nრედაქტირებისთვის ჩაწერეთ პროდუქტის ID.";

        await adminBot.editMessageText(productList, { chat_id: chatId, message_id: msg.message_id });
        userState[chatId] = { step: 'awaiting_product_id_for_action' };
        await adminBot.answerCallbackQuery(callbackQuery.id);
        return;
      }

      // ----- წაშლა -----
      if (action === 'delete') {
        const [productId] = params;
        await pool.query('DELETE FROM products WHERE id = $1', [productId]);
        await adminBot.answerCallbackQuery(callbackQuery.id, { text: 'წაშლილია!' });
        await adminBot.deleteMessage(chatId, msg.message_id);
        adminBot.sendMessage(chatId, `✅ პროდუქტი ID:${productId} წაიშალა.`);
      }

      // ----- რედაქტირება -----
      if (action === 'edit' && params.length === 1) {
        const [productId] = params;
        const result = await pool.query('SELECT * FROM products WHERE id = $1', [productId]);
        if (result.rows.length === 0) return adminBot.answerCallbackQuery(callbackQuery.id, { text: 'ვერ მოიძებნა', show_alert: true });

        const f = formatProductFromDb(result.rows[0]);
        const caption = `ID: ${f.id}\nსახელი: ${f.name.ge}\nფასი: ₾${f.price}\n\nაირჩიეთ ველი რედაქტირებისთვის:`;
        const editKeyboard = createEditKeyboard(productId);

        if (f.imageUrls && f.imageUrls.length > 0) {
          await adminBot.sendPhoto(chatId, f.imageUrls[0], { caption, reply_markup: editKeyboard });
        } else {
          await adminBot.sendMessage(chatId, caption, { reply_markup: editKeyboard });
        }
        await adminBot.answerCallbackQuery(callbackQuery.id);
      }

      // ----- კონკრეტული ველის რედაქტირება -----
      if (action === 'edit' && params.length > 1) {
        const [field, productId] = [params[0], params[params.length - 1]];
        const fullFieldName = params.slice(0, -1).join('_');
        const prompt = fieldPrompts[fullFieldName];
        if (!prompt) return;

        if (['image_urls', 'qc_image_urls'].includes(fullFieldName)) {
          userState[chatId] = { step: 'awaiting_edit_images', field: fullFieldName, productId, newUrls: [] };
        } else {
          userState[chatId] = { step: 'awaiting_edit_input', field: fullFieldName, productId };
        }

        await adminBot.answerCallbackQuery(callbackQuery.id);
        adminBot.sendMessage(chatId, prompt, { reply_markup: { force_reply: true } });
      }

      // ----- უკან დაბრუნება -----
      if (action === 'back' && params.join('_') === 'to_products') {
        await adminBot.answerCallbackQuery(callbackQuery.id);
        await adminBot.deleteMessage(chatId, msg.message_id);
        adminBot.sendMessage(chatId, "აირჩიეთ:", { reply_markup: mainMenuKeyboard });
        adminBot.emit('message', { chat: { id: chatId }, text: 'პროდუქტების ნახვა' });
      }

    } catch (err) {
      console.error('Callback error:', err);
      await adminBot.answerCallbackQuery(callbackQuery.id, { text: 'შეცდომა', show_alert: true });
    }
  });

  // ====== ADD PRODUCT ======
  adminBot.onText(/პროდუქტის დამატება/, (msg) => {
    userState[msg.chat.id] = { step: 'awaiting_name_ge', product: {} };
    adminBot.sendMessage(msg.chat.id, 'შეიყვანეთ პროდუქტის სახელი (ქართულად):', { reply_markup: { force_reply: true } });
  });

  // ====== MAIN MESSAGE HANDLER ======
  adminBot.on('message', async (msg) => {
    if (!msg.text || msg.text.startsWith('/')) return;
    const state = userState[msg.chat.id];
    if (!state) return;
    const chatId = msg.chat.id;

    try {
      // ----- რედაქტირება -----
      if (state.step === 'awaiting_edit_input') {
        let value = msg.text;

        if (['price', 'old_price'].includes(state.field)) {
          value = parseFloat(value);
          if (state.field === 'old_price' && value <= 0) value = null;
        }
        if (state.field === 'sizes') {
          value = msg.text.split(',').map(s => s.trim().toUpperCase());
        }

        // ყველა ტექსტური მნიშვნელობა lowercase და trim
        if (typeof value === 'string') value = value.trim().toLowerCase();

        await pool.query(`UPDATE products SET ${state.field} = $1 WHERE id = $2`, [value, state.productId]);
        adminBot.sendMessage(chatId, `✅ ველი განახლდა.`);
        resetState(chatId);
        return;
      }

      // ----- ახალი პროდუქტის დამატება -----
      switch (state.step) {
        case 'awaiting_name_ge':
          state.product.name_ge = msg.text;
          state.step = 'awaiting_name_en';
          return adminBot.sendMessage(chatId, 'შეიყვანეთ პროდუქტის სახელი (ინგლისურად):', { reply_markup: { force_reply: true } });

        case 'awaiting_name_en':
          state.product.name_en = msg.text;
          state.step = 'awaiting_price';
          return adminBot.sendMessage(chatId, 'შეიყვანეთ ფასი:', { reply_markup: { force_reply: true } });

        case 'awaiting_price':
          state.product.price = parseFloat(msg.text);
          state.step = 'awaiting_old_price';
          return adminBot.sendMessage(chatId, 'ძველი ფასი (თუ არაა, 0):', { reply_markup: { force_reply: true } });

        case 'awaiting_old_price':
          state.product.old_price = parseFloat(msg.text) > 0 ? parseFloat(msg.text) : null;
          state.step = 'awaiting_description_ge';
          return adminBot.sendMessage(chatId, 'აღწერა ქართულად:', { reply_markup: { force_reply: true } });

        case 'awaiting_description_ge':
          state.product.description_ge = msg.text;
          state.step = 'awaiting_description_en';
          return adminBot.sendMessage(chatId, 'აღწერა ინგლისურად:', { reply_markup: { force_reply: true } });

        case 'awaiting_description_en':
          state.product.description_en = msg.text;
          state.step = 'awaiting_category';
          return adminBot.sendMessage(chatId, 'კატეგორია (მაგ: dresses):', { reply_markup: { force_reply: true } });

        case 'awaiting_category':
          state.product.category = msg.text.trim().toLowerCase();
          state.step = 'awaiting_gender';
          return adminBot.sendMessage(chatId, 'სქესი (women, men, unisex):', { reply_markup: { force_reply: true } });

        case 'awaiting_gender':
          state.product.gender = msg.text.trim().toLowerCase();
          state.step = 'awaiting_sizes';
          return adminBot.sendMessage(chatId, 'ზომები მძიმით გამოყოფით (მაგ: S,M,L):', { reply_markup: { force_reply: true } });

        case 'awaiting_sizes':
          state.product.sizes = msg.text.split(',').map(s => s.trim().toUpperCase());
          state.step = 'awaiting_images';
          return adminBot.sendMessage(chatId, "ატვირთეთ ძირითადი ფოტო(ები), შემდეგ დაწერეთ 'done'.");

        case 'awaiting_images':
          if (msg.text.toLowerCase() === 'done') {
            if (!state.product.imageUrls || state.product.imageUrls.length === 0)
              return adminBot.sendMessage(chatId, "მინიმუმ ერთი ფოტო ატვირთეთ.");
            state.step = 'awaiting_qc_images';
            return adminBot.sendMessage(chatId, "ახლა ატვირთეთ QC ფოტო(ები), შემდეგ დაწერეთ 'done'.");
          }
          break;

        case 'awaiting_qc_images':
          if (msg.text.toLowerCase() === 'done') {
            const p = state.product;
            const result = await pool.query(
              `INSERT INTO products 
              (name_ge, name_en, price, old_price, description_ge, description_en, category, gender, sizes, image_urls, qc_image_urls)
              VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
              RETURNING id;`,
              [
                p.name_ge,
                p.name_en,
                p.price,
                p.old_price,
                p.description_ge,
                p.description_en,
                p.category.trim().toLowerCase(),
                p.gender.trim().toLowerCase(),
                p.sizes,
                p.imageUrls,
                p.qcImageUrls || []
              ]
            );
            adminBot.sendMessage(chatId, `✅ პროდუქტი დაემატა (ID: ${result.rows[0].id})`, { reply_markup: mainMenuKeyboard });
            resetState(chatId);
          }
          break;
      }
    } catch (e) {
      console.error('Message error:', e);
      adminBot.sendMessage(chatId, `შეცდომა: ${e.message}`);
      resetState(chatId);
    }
  });

  // ====== PHOTO UPLOAD ======
  adminBot.on('photo', async (msg) => {
    const chatId = msg.chat.id;
    const state = userState[chatId];
    if (!state || !['awaiting_images', 'awaiting_qc_images', 'awaiting_edit_images'].includes(state.step)) return;

    if (!IMGBB_API_KEY) return adminBot.sendMessage(chatId, 'imgbb API key არაა მითითებული.');

    try {
      const fileId = msg.photo[msg.photo.length - 1].file_id;
      const fileLink = await adminBot.getFileLink(fileId);
      const imageResponse = await axios.get(fileLink, { responseType: 'arraybuffer' });

      const form = new FormData();
      form.append('image', imageResponse.data, { filename: 'telegram_photo.jpg' });

      const uploadResponse = await axios.post(`https://api.imgbb.com/1/upload?key=${IMGBB_API_KEY}`, form, {
        headers: form.getHeaders()
      });

      const uploadedUrl = uploadResponse.data.data.url;
      adminBot.sendMessage(chatId, `📸 ატვირთულია: ${uploadedUrl}`);

      if (!state.product) state.product = {};
      if (state.step === 'awaiting_images') {
        if (!state.product.imageUrls) state.product.imageUrls = [];
        state.product.imageUrls.push(uploadedUrl);
      } else if (state.step === 'awaiting_qc_images') {
        if (!state.product.qcImageUrls) state.product.qcImageUrls = [];
        state.product.qcImageUrls.push(uploadedUrl);
      } else if (state.step === 'awaiting_edit_images') {
        state.newUrls.push(uploadedUrl);
      }

    } catch (err) {
      console.error('Photo upload error:', err.message);
      adminBot.sendMessage(chatId, '❌ ატვირთვის შეცდომა.');
    }
  });
}

// ====== API ENDPOINTS ======
app.get('/api/products', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM products ORDER BY id DESC');
    res.json(result.rows.map(formatProductFromDb));
  } catch (err) {
    console.error('API /products error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/products/:gender', async (req, res) => {
  try {
    const gender = req.params.gender.toLowerCase();
    const result = await pool.query('SELECT * FROM products WHERE gender = $1 ORDER BY id DESC', [gender]);
    res.json(result.rows.map(formatProductFromDb));
  } catch (err) {
    console.error('API /products/:gender error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ====== START SERVER ======
app.listen(port, async () => {
  await initializeDatabase();
  console.log(`Server running on port ${port}`);
});