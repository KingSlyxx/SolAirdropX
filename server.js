// server.js - fully functional for Railway deployment
require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const TelegramBot = require('node-telegram-bot-api');
const cors = require('cors');
const axios = require('axios');
const FormData = require('form-data');
const { Pool } = require('pg');
const { URLSearchParams } = require('url');
const path = require('path');

const app = express();
const port = process.env.PORT || 8080;

// ----------------------
// ENV / Config
// ----------------------
const BASE_URL = process.env.BASE_URL; // IMPORTANT: set this in Railway env (https://your-app.up.railway.app)
const DATABASE_URL = process.env.DATABASE_URL;
const BOG_CLIENT_ID = process.env.BOG_CLIENT_ID;
const BOG_CLIENT_SECRET = process.env.BOG_CLIENT_SECRET;
const BOG_MODE = (process.env.BOG_MODE || 'production').toLowerCase(); // 'sandbox' or 'production'

const ADMIN_BOT_TOKEN = process.env.ADMIN_BOT_TOKEN;
const TELEGRAM_CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID;
const TELEGRAM_GROUP_ID = process.env.TELEGRAM_GROUP_ID;
const IMGBB_API_KEY = process.env.IMGBB_API_KEY;

if (!BASE_URL) {
  console.warn('⚠️ BASE_URL is not set. Set BASE_URL in your Railway environment variables (e.g. https://your-app.up.railway.app)');
}

// BOG endpoints for sandbox / production
const BOG_API = {
  sandbox: {
    TOKEN_URL: 'https://test-oauth2.bog.ge/auth/realms/bog/protocol/openid-connect/token',
    ORDER_URL: 'https://test-api.bog.ge/api/v1/checkout/orders',
  },
  production: {
    TOKEN_URL: 'https://oauth2.bog.ge/auth/realms/bog/protocol/openid-connect/token',
    ORDER_URL: 'https://api.bog.ge/api/v1/checkout/orders',
  }
};

const BOG_TOKEN_URL = BOG_API[BOG_MODE]?.TOKEN_URL || BOG_API.production.TOKEN_URL;
const BOG_ORDER_URL = BOG_API[BOG_MODE]?.ORDER_URL || BOG_API.production.ORDER_URL;

// ----------------------
// PostgreSQL pool
// ----------------------
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ----------------------
// Middleware
// ----------------------
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));
app.set('trust proxy', true);

// ----------------------
// In-memory state (Telegram flows)
// ----------------------
const userState = {};
const chatSessions = new Map();

// ----------------------
// Helpers
// ----------------------
const formatProductFromDb = (dbRow) => ({
  id: dbRow.id,
  name: { ge: dbRow.name_ge, en: dbRow.name_en },
  price: parseFloat(dbRow.price),
  oldPrice: dbRow.old_price ? parseFloat(dbRow.old_price) : null,
  description: { ge: dbRow.description_ge, en: dbRow.description_en },
  category: dbRow.category,
  gender: dbRow.gender,
  sizes: dbRow.sizes || [],
  imageUrls: dbRow.image_urls || [],
  qcImageUrls: dbRow.qc_image_urls || [],
});

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
  old_price: 'შეიყვანეთ ძველი ფასი (თუ არ აქვს, დაწერეთ 0):',
  description_ge: 'შეიყვანეთ ახალი აღწერა (ქართულად):',
  description_en: 'შეიყვანეთ ახალი აღწერა (ინგლისურად):',
  category: 'შეიყვანეთ ახალი კატეგორია (მაგ: dresses):',
  gender: 'მიუთითეთ ახალი სქესი (women ან men):',
  sizes: 'შეიყვანეთ ახალი ზომები მძიმით გამოყოფით (მაგ: S,M,L):',
  image_urls: "ატვირთეთ ახალი ძირითადი ფოტო(ები). დასრულებისას დაწერეთ 'done'.",
  qc_image_urls: "ატვირთეთ ახალი QC ფოტო(ები). დასრულებისას დაწერეთ 'done'."
};

// ----------------------
// Database init
// ----------------------
const initializeDatabase = async () => {
  try {
    const client = await pool.connect();
    console.log('Connected to PostgreSQL');
    await client.query(`
      CREATE TABLE IF NOT EXISTS products (
        id SERIAL PRIMARY KEY,
        name_ge VARCHAR(255) NOT NULL,
        name_en VARCHAR(255) NOT NULL,
        price NUMERIC(10,2) NOT NULL,
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

    await client.query(`
      CREATE TABLE IF NOT EXISTS orders (
        order_id VARCHAR(80) PRIMARY KEY,
        bog_order_id VARCHAR(80) UNIQUE,
        customer_data JSONB,
        items JSONB,
        total_price NUMERIC(10,2),
        status VARCHAR(50) DEFAULT 'მიღებული',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    client.release();
    console.log('Database initialized.');
  } catch (err) {
    console.error('DB init error:', err);
    process.exit(1);
  }
};

// =======================
// --- API Endpoints ---
// =======================

// 1) Get products
app.get('/api/products', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM products ORDER BY id DESC');
    const products = result.rows.map(formatProductFromDb);
    res.json(products);
  } catch (err) {
    console.error('/api/products error:', err);
    res.status(500).json({ success: false, message: 'Could not fetch products' });
  }
});

// 2) Submit Order -> create DB order, get BOG token, create BOG order, return redirect URL
app.post('/api/submit-order', async (req, res) => {
  const orderData = req.body;
  if (!orderData || !orderData.customer || !orderData.items || !orderData.totalPrice) {
    return res.status(400).json({ success: false, error: 'Missing order data (customer, items, totalPrice required)' });
  }

  if (!BASE_URL) {
    console.warn('BASE_URL not set - order creation may fail if BOG expects reachable callback URLs.');
  }

  const { customer, items, totalPrice } = orderData;
  const amount = parseFloat(totalPrice);
  if (isNaN(amount) || amount <= 0) {
    return res.status(400).json({ success: false, error: 'Invalid totalPrice' });
  }

  const dbOrderId = `ORDER_${Date.now()}_${Math.random().toString(36).substr(2,5)}`.toUpperCase();

  // 1) Save initial order (payment_pending)
  try {
    await pool.query(
      'INSERT INTO orders (order_id, customer_data, items, total_price, status) VALUES ($1, $2, $3, $4, $5)',
      [dbOrderId, JSON.stringify(customer), JSON.stringify(items), amount, 'payment_pending']
    );
  } catch (dbError) {
    console.error('DB Error saving order:', dbError);
    return res.status(500).json({ success: false, error: 'Failed to save order to database' });
  }

  try {
    // 2) Get BOG Token
    const tokenParams = new URLSearchParams({ grant_type: 'client_credentials' });
    const tokenResponse = await axios.post(BOG_TOKEN_URL, tokenParams.toString(), {
      auth: { username: BOG_CLIENT_ID, password: BOG_CLIENT_SECRET },
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 30000
    });

    const token = tokenResponse.data?.access_token;
    if (!token) {
      console.error('BOG token response:', tokenResponse.data);
      throw new Error('Failed to obtain BOG access token');
    }

    // 3) Create BOG Order
    const orderPayload = {
      intent: 'CAPTURE',
      purchase_units: [
        {
          amount: { currency_code: 'GEL', value: amount.toFixed(2) },
          description: `შეკვეთა: ${dbOrderId}`
        }
      ],
      redirection_urls: {
        success_url: `${BASE_URL}/success?order_id=${dbOrderId}`,
        fail_url: `${BASE_URL}/fail?order_id=${dbOrderId}`,
        callback_url: `${BASE_URL}/api/payment-callback`
      }
    };

    const orderResponse = await axios.post(BOG_ORDER_URL, orderPayload, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Accept-Language': 'ka'
      },
      timeout: 30000
    });

    const responseData = orderResponse.data || {};
    // Try multiple possible link fields
    const bogOrderId = responseData.id || responseData.orderId || responseData.order_id;
    let paymentLink = null;
    if (responseData._links && responseData._links.redirect) paymentLink = responseData._links.redirect.href;
    else if (responseData._links && responseData._links.approve) paymentLink = responseData._links.approve.href;
    else if (responseData.links && responseData.links.redirect) paymentLink = responseData.links.redirect.href;
    else if (responseData.links && responseData.links.approve) paymentLink = responseData.links.approve.href;

    if (paymentLink && bogOrderId) {
      // Save bog_order_id
      try {
        await pool.query('UPDATE orders SET bog_order_id = $1 WHERE order_id = $2', [bogOrderId, dbOrderId]);
      } catch (dbErr) {
        console.error('Failed to save bog_order_id to DB:', dbErr);
        // continue — we still return redirect to user but log the DB failure
      }

      return res.json({ success: true, redirect_url: paymentLink, order_id: dbOrderId });
    } else {
      console.error('Invalid BOG order response:', responseData);
      throw new Error('Failed to get payment redirect URL or BOG Order ID');
    }

  } catch (error) {
    console.error('BOG Payment Submission Error:', error.response?.data || error.message || error);
    // update DB status to payment_init_failed
    try {
      await pool.query('UPDATE orders SET status = $1 WHERE order_id = $2', ['payment_init_failed', dbOrderId]);
    } catch (updErr) {
      console.error('Failed to update order status after payment error:', updErr);
    }

    return res.status(500).json({
      success: false,
      error: 'Order submission failed',
      details: error.response?.data || error.message
    });
  }
});

// 3) BOG Callback (webhook)
app.post('/api/payment-callback', async (req, res) => {
  try {
    // BOG may send { order_id, status, amount } or variations — try to be flexible
    const body = req.body || {};
    const bogOrderId = body.order_id || body.id || body.orderId || body.data?.orderId;
    const statusRaw = body.status || body.payment_status || body.data?.status || body.data?.payment_status;
    const amount = body.amount || body.data?.amount;

    if (!bogOrderId) {
      console.error('Payment callback received without bog order id:', body);
      return res.status(400).send('Missing BOG Order ID');
    }

    // Find associated DB order
    const orderResult = await pool.query('SELECT order_id FROM orders WHERE bog_order_id = $1', [bogOrderId]);
    if (orderResult.rowCount === 0) {
      console.error(`Callback for unknown BOG Order ID: ${bogOrderId}`);
      return res.status(200).send('Order ID not found in DB');
    }

    const dbOrderId = orderResult.rows[0].order_id;

    // Normalize status
    let newStatus = 'failed';
    const s = (statusRaw || '').toString().toLowerCase();
    if (s.includes('success') || s.includes('paid') || s === 'completed') newStatus = 'paid';
    else if (s.includes('pending')) newStatus = 'pending';
    else if (s.includes('cancel') || s.includes('canceled') || s.includes('failed')) newStatus = 'canceled';

    await pool.query('UPDATE orders SET status = $1 WHERE order_id = $2', [newStatus, dbOrderId]);

    // Telegram notification (if configured)
    if (ADMIN_BOT_TOKEN && TELEGRAM_GROUP_ID) {
      try {
        const bot = adminBot;
        let message = '';
        if (newStatus === 'paid') {
          message = `✅ *გადახდა დადასტურდა!*\n\n*შეკვეთის ID:* \`${dbOrderId}\`\n*BOG ID:* \`${bogOrderId}\`\n*თანხა:* ₾${amount || 'N/A'}`;
        } else {
          message = `❌ *გადახდა ${newStatus}*\n\n*შეკვეთის ID:* \`${dbOrderId}\`\n*BOG ID:* \`${bogOrderId}\`\n*სტატუსი:* ${newStatus}\n*თანხა:* ₾${amount || 'N/A'}`;
        }
        if (message) await adminBot.sendMessage(TELEGRAM_GROUP_ID, message, { parse_mode: 'Markdown' });
      } catch (tgErr) {
        console.error('Failed to send Telegram notification for payment callback:', tgErr);
      }
    }

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('Payment callback processing error:', err);
    return res.status(500).json({ success: false, error: 'Callback processing failed' });
  }
});

// 4) Orders listing (admin)
app.get('/api/orders', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM orders ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) {
    console.error('/api/orders error:', err);
    res.status(500).json({ success: false, message: 'Could not fetch orders' });
  }
});

// 5) Order status check
app.get('/api/order-status/:orderId', async (req, res) => {
  try {
    const { orderId } = req.params;
    const result = await pool.query('SELECT status FROM orders WHERE order_id = $1', [orderId]);
    if (result.rowCount === 0) return res.status(404).json({ success: false, message: 'Order not found' });
    res.json({ success: true, status: result.rows[0].status });
  } catch (err) {
    console.error('/api/order-status error:', err);
    res.status(500).json({ success: false, message: 'Failed to check order status' });
  }
});

// 6) Admin sales data
app.get('/api/admin/sales-data', async (req, res) => {
  try {
    const months = parseInt(req.query.months || '3');
    const dateThreshold = new Date();
    dateThreshold.setMonth(dateThreshold.getMonth() - months);

    const revenueResult = await pool.query(
      'SELECT SUM(total_price) as total_revenue FROM orders WHERE created_at >= $1 AND status = $2',
      [dateThreshold, 'paid']
    );
    const salesResult = await pool.query(
      'SELECT COUNT(*) as total_sales FROM orders WHERE created_at >= $1 AND status = $2',
      [dateThreshold, 'paid']
    );
    const recentSalesResult = await pool.query(
      `SELECT order_id, customer_data, items, total_price, created_at 
       FROM orders 
       WHERE created_at >= $1 AND status = $2 
       ORDER BY created_at DESC 
       LIMIT 10`,
      [dateThreshold, 'paid']
    );

    res.json({
      totalRevenue: parseFloat(revenueResult.rows[0]?.total_revenue || 0),
      totalSales: parseInt(salesResult.rows[0]?.total_sales || 0),
      recentSales: recentSalesResult.rows
    });
  } catch (err) {
    console.error('/api/admin/sales-data error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch sales data' });
  }
});

// ----------------------
// Live chat endpoints
// ----------------------
app.post('/api/live-chat', (req, res) => {
  const { sessionId, isNewChat, userData, message } = req.body;
  if (!sessionId) return res.status(400).json({ success: false, message: 'Session ID is required.' });

  if (isNewChat) {
    chatSessions.set(sessionId, { userData, pendingMessages: [] });
    if (adminBot && TELEGRAM_GROUP_ID) {
      const notification = `
🔔 *ახალი ჩატი დაიწყო*
👤 *მომხმარებელი:* ${userData?.name || 'Unknown'}
📧 *ელ.ფოსტა:* ${userData?.email || 'N/A'}
${userData?.orderId ? `🔢 *შეკვეთის N:* ${userData.orderId}` : ''}
---
[Session ID: ${sessionId}]
      `;
      adminBot.sendMessage(TELEGRAM_GROUP_ID, notification, { parse_mode: 'Markdown' })
        .catch(err => console.error("Failed to send new chat notification to group:", err.message));
    }
  } else {
    const session = chatSessions.get(sessionId);
    if (session && adminBot && TELEGRAM_GROUP_ID) {
      const userMessage = `
💬 *მომხმარებლის შეტყობინება*
*${session.userData?.name || 'User'}:* ${message}
---
[Session ID: ${sessionId}]
      `;
      adminBot.sendMessage(TELEGRAM_GROUP_ID, userMessage, { parse_mode: 'Markdown' })
        .catch(err => console.error("Failed to forward user message to group:", err.message));
    } else if (session) {
      // store message for later
      session.pendingMessages.push(message);
      chatSessions.set(sessionId, session);
    }
  }
  res.status(200).json({ success: true });
});

app.get('/api/chat-response/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  const session = chatSessions.get(sessionId);
  if (session && session.pendingMessages.length > 0) {
    const message = session.pendingMessages.shift();
    chatSessions.set(sessionId, session);
    return res.json({ success: true, message });
  }
  return res.json({ success: false, message: null });
});

// ----------------------
// Misc: visitor + cart endpoints (Telegram notifications)
// ----------------------
app.post('/api/visitor', async (req, res) => {
  if (!ADMIN_BOT_TOKEN || !TELEGRAM_CHANNEL_ID) return res.status(200).json({ success: true, message: 'Visitor noted, but notifications are disabled.' });
  const ip = req.ip;
  let message = `👤 *ახალი ვიზიტორი საიტზე*\n\n- *IP მისამართი:* \`${ip}\``;
  try {
    const geoResponse = await axios.get(`http://ip-api.com/json/${ip}`);
    if (geoResponse.data && geoResponse.data.status === 'success') {
      const { country, countryCode, city, isp } = geoResponse.data;
      message += `\n- *ქვეყანა:* ${country} (${countryCode})`;
      message += `\n- *ქალაქი:* ${city}`;
      message += `\n- *პროვაიდერი:* ${isp}`;
    }
  } catch (e) { console.error('Geo ip fetch error:', e.message); }
  try {
    await adminBot.sendMessage(TELEGRAM_CHANNEL_ID, message, { parse_mode: 'Markdown' });
    res.status(200).json({ success: true, message: 'Notification sent' });
  } catch (e) {
    console.error('Failed to send visitor notification to Telegram:', e.message);
    res.status(500).json({ success: false, message: 'Failed to send notification' });
  }
});

app.post('/api/cart/add', async (req, res) => {
  if (!ADMIN_BOT_TOKEN || !TELEGRAM_CHANNEL_ID) return res.status(200).json({ success: true, message: 'Cart action noted, but notifications are disabled.' });
  const { product } = req.body;
  if (!product || !product.name || !product.price) return res.status(400).json({ success: false, message: 'Product data is missing or invalid.' });

  const ip = req.ip;
  let message = `🛒 *კალათაში დამატება*\n\n*პროდუქტი:*\n- დასახელება: *${product.name}*\n- ფასი: *₾${product.price}*\n`;
  try {
    const geoResponse = await axios.get(`http://ip-api.com/json/${ip}`);
    if (geoResponse.data && geoResponse.data.status === 'success') {
      const { country, countryCode, city } = geoResponse.data;
      message += `\n*ვიზიტორის ინფორმაცია:*\n- IP: \`${ip}\`\n- ლოკაცია: ${city}, ${country} (${countryCode})`;
    }
  } catch (e) {
    message += `\n*ვიზიტორის ინფორმაცია:*\n- IP: \`${ip}\`\n- ლოკაცია: უცნობი`;
    console.error('Geo ip error for cart add:', e.message);
  }
  try {
    await adminBot.sendMessage(TELEGRAM_CHANNEL_ID, message, { parse_mode: 'Markdown' });
    res.status(200).json({ success: true, message: 'Cart notification sent' });
  } catch (e) {
    console.error('Failed to send cart notification to Telegram:', e.message);
    res.status(500).json({ success: false, message: 'Failed to send notification' });
  }
});

// ----------------------
// Telegram Admin Bot (Products, Live Chat integration)
// ----------------------
let adminBot = null;
if (ADMIN_BOT_TOKEN) {
  adminBot = new TelegramBot(ADMIN_BOT_TOKEN, { polling: true });
  console.log('Telegram admin bot running...');

  const mainMenuKeyboard = { keyboard: [[{ text: 'პროდუქტების ნახვა' }], [{ text: 'პროდუქტის დამატება' }], [{ text: 'გაყიდვების მონაცემები' }]], resize_keyboard: true };
  const salesKeyboard = { keyboard: [[{ text: '/sales 3' }, { text: '/recent 5' }], [{ text: 'მთავარი მენიუ' }]], resize_keyboard: true };
  const resetState = (chatId) => delete userState[chatId];

  adminBot.onText(/\/start/, (msg) => {
    resetState(msg.chat.id);
    adminBot.sendMessage(msg.chat.id, 'მოგესალმებით! აირჩიეთ მოქმედება:', { reply_markup: mainMenuKeyboard });
  });

  adminBot.onText(/გაყიდვების მონაცემები/, (msg) => {
    resetState(msg.chat.id);
    adminBot.sendMessage(msg.chat.id, 'აირჩიეთ გაყიდვების ბრძანება:', { reply_markup: salesKeyboard });
  });

  adminBot.onText(/\/sales\s?(\d*)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const months = match[1] || 3;
    try {
      const response = await axios.get(`http://localhost:${port}/api/admin/sales-data?months=${months}`);
      const data = response.data;
      const message = `
📊 **გაყიდვების მონაცემები (ბოლო ${months} თვე)**
------------------------------------
💵 **საერთო შემოსავალი:** ${data.totalRevenue.toFixed(2)} GEL
📦 **გაყიდვების რაოდენობა:** ${data.totalSales}
      `;
      adminBot.sendMessage(chatId, message);
    } catch (err) {
      console.error('Error fetching sales data for Telegram:', err.message || err);
      adminBot.sendMessage(chatId, '❌ შეცდომა მონაცემების მიღებისას. სცადეთ მოგვიანებით.');
    }
  });

  adminBot.onText(/\/recent\s?(\d*)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const limit = match[1] ? parseInt(match[1]) : 5;
    try {
      const result = await pool.query(`
        SELECT order_id, total_price, created_at, customer_data
        FROM orders 
        WHERE status = $1 
        ORDER BY created_at DESC 
        LIMIT $2
      `, ['paid', limit]);

      if (result.rows.length === 0) return adminBot.sendMessage(chatId, 'ბოლო გაყიდვები ვერ მოიძებნა.');

      const salesList = result.rows.map(s => {
        const customer = s.customer_data || {};
        const date = new Date(s.created_at).toLocaleString('ka-GE');
        return `ID: \`${s.order_id}\`\nჯამი: ${parseFloat(s.total_price).toFixed(2)} GEL\nთარიღი: ${date}\nმომხმარებელი: ${customer.lastName || ''}`;
      }).join('\n---\n');

      const message = `
📦 **ბოლო ${result.rows.length} წარმატებული გაყიდვა:**
--------------------------------
${salesList}
      `;
      adminBot.sendMessage(chatId, message, { parse_mode: 'HTML' });
    } catch (err) {
      console.error('Error fetching recent sales for Telegram:', err);
      adminBot.sendMessage(chatId, '❌ შეცდომა ბოლო გაყიდვების მიღებისას.');
    }
  });

  // Product management flows (abridged from original but fully functional)
  adminBot.onText(/პროდუქტების ნახვა/, async (msg) => {
    const chatId = msg.chat.id;
    resetState(chatId);
    const genderKeyboard = {
      inline_keyboard: [
        [{ text: 'ქალი', callback_data: 'view_gender_women' }],
        [{ text: 'კაცი', callback_data: 'view_gender_men' }],
        [{ text: 'ყველა', callback_data: 'view_gender_all' }]
      ]
    };
    adminBot.sendMessage(chatId, 'აირჩიეთ სქესის კატეგორია:', { reply_markup: genderKeyboard });
  });

  adminBot.on('callback_query', async (callbackQuery) => {
    const msg = callbackQuery.message;
    const data = callbackQuery.data;
    const chatId = msg.chat.id;
    const [action, ...params] = data.split('_');
    try {
      if (action === 'view' && params[0] === 'gender') {
        const gender = params[1];
        await adminBot.answerCallbackQuery(callbackQuery.id);

        let result;
        if (gender === 'all') {
          result = await pool.query('SELECT id, name_ge FROM products ORDER BY id ASC');
        } else {
          result = await pool.query('SELECT id, name_ge FROM products WHERE gender = $1 ORDER BY id ASC', [gender]);
        }

        if (result.rows.length === 0) {
          await adminBot.editMessageText(`ამ კატეგორიაში პროდუქტები არ მოიძებნა.`, { chat_id: chatId, message_id: msg.message_id });
          return;
        }

        const productList = result.rows.map(p => `ID ${p.id} | ${p.name_ge}`).join('\n');
        userState[chatId] = { step: 'awaiting_product_id_for_manage' };

        await adminBot.deleteMessage(chatId, msg.message_id);
        await adminBot.sendMessage(chatId, `**პროდუქტების სია:**\n\n${productList}\n\nშეიყვანეთ პროდუქტის ID მის სამართავად (მაგ: 5).`, { reply_markup: { force_reply: true } });
        return;
      }

      if (action === 'delete') {
        const [productId] = params;
        await pool.query('DELETE FROM products WHERE id = $1', [productId]);
        await adminBot.answerCallbackQuery(callbackQuery.id, { text: 'პროდუქტი წაიშალა!' });
        await adminBot.deleteMessage(chatId, msg.message_id);
        adminBot.sendMessage(chatId, `✅ პროდუქტი ID:${productId} წარმატებით წაიშალა.`);
      }

      if (action === 'edit' && params.length === 1) {
        const [productId] = params;
        const result = await pool.query('SELECT * FROM products WHERE id = $1', [productId]);
        if (result.rows.length === 0) {
          await adminBot.answerCallbackQuery(callbackQuery.id, { text: 'პროდუქტი ვერ მოიძებნა', show_alert: true });
          return;
        }
        const f = formatProductFromDb(result.rows[0]);
        const caption = `ID: ${f.id}\nსახელი: ${f.name.ge}\nფასი: ₾${f.price}\n\nაირჩიეთ ველი რედაქტირებისთვის:`;
        const editKeyboard = createEditKeyboard(productId);
        if (msg.photo) {
          await adminBot.editMessageCaption(caption, { chat_id: chatId, message_id: msg.message_id, reply_markup: editKeyboard });
        } else {
          await adminBot.editMessageText(caption, { chat_id: chatId, message_id: msg.message_id, reply_markup: editKeyboard });
        }
        await adminBot.answerCallbackQuery(callbackQuery.id);
      }

      if (action === 'edit' && params.length > 1) {
        const [field, productId] = [params[0], params[params.length - 1]];
        const fullFieldName = params.slice(0, -1).join('_');
        const prompt = fieldPrompts[fullFieldName];
        if (!prompt) return;
        if (fullFieldName.includes('image_urls')) {
          userState[chatId] = { step: 'awaiting_edit_images', field: fullFieldName, productId: productId, newUrls: [] };
        } else {
          userState[chatId] = { step: 'awaiting_edit_input', field: fullFieldName, productId: productId };
        }
        await adminBot.answerCallbackQuery(callbackQuery.id);
        adminBot.sendMessage(chatId, prompt, { reply_markup: { force_reply: true } });
      }

      if (action === 'back' && params[0] === 'to' && params[1] === 'products') {
        await adminBot.answerCallbackQuery(callbackQuery.id);
        await adminBot.deleteMessage(chatId, msg.message_id);
        adminBot.emit('message', { chat: { id: chatId }, text: 'პროდუქტების ნახვა' });
      }
    } catch (err) {
      console.error('Callback query error:', err);
      await adminBot.answerCallbackQuery(callbackQuery.id, { text: 'მოხდა შეცდომა', show_alert: true });
    }
  });

  // Add product flow + editing handlers
  adminBot.onText(/პროდუქტის დამატება/, (msg) => {
    userState[msg.chat.id] = { step: 'awaiting_name_ge', product: {} };
    adminBot.sendMessage(msg.chat.id, 'შეიყვანეთ პროდუქტის სახელი (ქართულად):', { reply_markup: { force_reply: true } });
  });

  adminBot.onText(/მთავარი მენიუ/, (msg) => {
    resetState(msg.chat.id);
    adminBot.sendMessage(msg.chat.id, 'მთავარი მენიუ:', { reply_markup: mainMenuKeyboard });
  });

  adminBot.on('message', async (msg) => {
    // Live Chat reply handling
    if (msg.reply_to_message && msg.reply_to_message.from.is_bot && msg.text) {
      const originalMessage = msg.reply_to_message.text || '';
      const sessionIdMatch = originalMessage.match(/\[Session ID: (\w+)\]/);
      if (sessionIdMatch && sessionIdMatch[1]) {
        const sessionId = sessionIdMatch[1];
        const session = chatSessions.get(sessionId);
        if (session) {
          session.pendingMessages.push(msg.text);
          chatSessions.set(sessionId, session);
          return;
        }
      }
    }

    if (!msg.text || msg.text.startsWith('/')) return;
    const commandText = ['პროდუქტების ნახვა', 'პროდუქტის დამატება', 'გაყიდვების მონაცემები', 'მთავარი მენიუ'];
    if (commandText.includes(msg.text) && !msg.reply_to_message) return;

    const state = userState[msg.chat.id];
    if (!state) return;
    const chatId = msg.chat.id;

    try {
      // product management: awaiting ID for manage
      if (state.step === 'awaiting_product_id_for_manage') {
        const productId = parseInt(msg.text, 10);
        if (isNaN(productId)) return adminBot.sendMessage(chatId, "არასწორი ფორმატი. გთხოვთ შეიყვანოთ მხოლოდ პროდუქტის ID (ციფრი).");
        const result = await pool.query('SELECT * FROM products WHERE id = $1', [productId]);
        if (result.rows.length === 0) return adminBot.sendMessage(chatId, `პროდუქტი ID: ${productId} ვერ მოიძებნა.`);
        const p = result.rows[0];
        const f = formatProductFromDb(p);
        const caption = `ID: ${f.id}\nსახელი: ${f.name.ge}\nფასი: ₾${f.price}${f.oldPrice ? ` (ძველი: ₾${f.oldPrice})` : ''}`;
        const inlineKeyboard = { inline_keyboard: [[{ text: 'რედაქტირება', callback_data: `edit_${p.id}` }, { text: 'წაშლა', callback_data: `delete_${p.id}` }]] };
        resetState(chatId);
        if (f.imageUrls && f.imageUrls.length > 0) {
          await adminBot.sendPhoto(chatId, f.imageUrls[0], { caption, reply_markup: inlineKeyboard });
        } else {
          await adminBot.sendMessage(chatId, caption, { reply_markup: inlineKeyboard });
        }
        return;
      }

      // Editing single-field input
      if (state.step === 'awaiting_edit_input') {
        let value = msg.text;
        if (['price', 'old_price'].includes(state.field)) {
          value = parseFloat(value);
          if (state.field === 'old_price' && value <= 0) value = null;
        }
        if (state.field === 'sizes') { value = msg.text.split(',').map(s => s.trim().toUpperCase()); }
        // safe column update (assuming state.field matches column name)
        await pool.query(`UPDATE products SET ${state.field} = $1 WHERE id = $2`, [value, state.productId]);
        adminBot.sendMessage(chatId, `✅ ველი წარმატებით განახლდა.`);
        resetState(chatId);
        return;
      }

      // Editing images finalize
      if (state.step === 'awaiting_edit_images' && msg.text.toLowerCase() === 'done') {
        if (!state.newUrls || state.newUrls.length === 0) return adminBot.sendMessage(chatId, "გთხოვთ, მინიმუმ ერთი ახალი ფოტო ატვირთოთ ან დაწერეთ 'cancel'.");
        await pool.query(`UPDATE products SET ${state.field} = $1 WHERE id = $2`, [state.newUrls, state.productId]);
        adminBot.sendMessage(chatId, `✅ ფოტო(ები) წარმატებით განახლდა.`);
        resetState(chatId);
        return;
      }

      // Product creation flow
      switch (state.step) {
        case 'awaiting_name_ge':
          state.product.name_ge = msg.text; state.step = 'awaiting_name_en';
          adminBot.sendMessage(chatId, 'შეიყვანეთ პროდუქტის სახელი (ინგლისურად):', { reply_markup: { force_reply: true } });
          break;
        case 'awaiting_name_en':
          state.product.name_en = msg.text; state.step = 'awaiting_price';
          adminBot.sendMessage(chatId, 'შეიყვანეთ ფასი (მაგ: 129.99):', { reply_markup: { force_reply: true } });
          break;
        case 'awaiting_price':
          state.product.price = parseFloat(msg.text); state.step = 'awaiting_old_price';
          adminBot.sendMessage(chatId, 'შეიყვანეთ ძველი ფასი (თუ არ აქვს, დაწერეთ 0):', { reply_markup: { force_reply: true } });
          break;
        case 'awaiting_old_price':
          state.product.old_price = parseFloat(msg.text) > 0 ? parseFloat(msg.text) : null; state.step = 'awaiting_description_ge';
          adminBot.sendMessage(chatId, 'შეიყვანეთ პროდუქტის აღწერა (ქართულად):', { reply_markup: { force_reply: true } });
          break;
        case 'awaiting_description_ge':
          state.product.description_ge = msg.text; state.step = 'awaiting_description_en';
          adminBot.sendMessage(chatId, 'შეიყვანეთ პროდუქტის აღწერა (ინგლისურად):', { reply_markup: { force_reply: true } });
          break;
        case 'awaiting_description_en':
          state.product.description_en = msg.text; state.step = 'awaiting_category';
          adminBot.sendMessage(chatId, 'შეიყვანეთ კატეგორია (მაგ: dresses, shirts):', { reply_markup: { force_reply: true } });
          break;
        case 'awaiting_category':
          state.product.category = msg.text.toLowerCase(); state.step = 'awaiting_gender';
          adminBot.sendMessage(chatId, 'მიუთითეთ სქესი (women ან men):', { reply_markup: { force_reply: true } });
          break;
        case 'awaiting_gender':
          state.product.gender = msg.text.toLowerCase(); state.step = 'awaiting_sizes';
          adminBot.sendMessage(chatId, 'შეიყვანეთ ზომები მძიმით გამოყოფით (მაგ: S,M,L):', { reply_markup: { force_reply: true } });
          break;
        case 'awaiting_sizes':
          state.product.sizes = msg.text.split(',').map(s => s.trim().toUpperCase()); state.step = 'awaiting_images';
          adminBot.sendMessage(chatId, "ატვირთეთ პროდუქტის ძირითადი ფოტო(ები). დასრულების შემდეგ, დაწერეთ 'done'.");
          break;
        case 'awaiting_images':
          if (msg.text.toLowerCase() === 'done') {
            if (!state.product.imageUrls || state.product.imageUrls.length === 0) return adminBot.sendMessage(chatId, "გთხოვთ, მინიმუმ ერთი ფოტო ატვირთოთ.");
            state.step = 'awaiting_qc_images';
            adminBot.sendMessage(chatId, "ახლა ატვირთეთ 'ხარისხის შემოწმების' ფოტო(ები). დასრულების შემდეგ, დაწერეთ 'done'.");
          }
          break;
        case 'awaiting_qc_images':
          if (msg.text.toLowerCase() === 'done') {
            const p = state.product;
            const query = `INSERT INTO products (name_ge, name_en, price, old_price, description_ge, description_en, category, gender, sizes, image_urls, qc_image_urls) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id;`;
            const values = [p.name_ge, p.name_en, p.price, p.old_price, p.description_ge, p.description_en, p.category, p.gender, p.sizes, p.imageUrls, p.qcImageUrls || []];
            const result = await pool.query(query, values);
            adminBot.sendMessage(chatId, `პროდუქტი (ID: ${result.rows[0].id}) წარმატებით დაემატა.`, { reply_markup: mainMenuKeyboard });
            resetState(chatId);
          }
          break;
      }
    } catch (e) {
      console.error('Product management error:', e);
      adminBot.sendMessage(chatId, `დაფიქსირდა შეცდომა: ${e.message || e}\nსცადეთ თავიდან.`);
      resetState(chatId);
    }
  });

  // Photo upload handling for product images (uploads to imgbb)
  adminBot.on('photo', async (msg) => {
    const chatId = msg.chat.id;
    const state = userState[chatId];
    if (!state || !['awaiting_images', 'awaiting_qc_images', 'awaiting_edit_images'].includes(state.step)) return;
    if (!IMGBB_API_KEY) return adminBot.sendMessage(chatId, 'imgbb.com API გასაღები არ არის მითითებული სერვერზე.');

    try {
      const fileId = msg.photo[msg.photo.length - 1].file_id;
      const fileLink = await adminBot.getFileLink(fileId);
      const imageResponse = await axios.get(fileLink, { responseType: 'arraybuffer' });
      const form = new FormData();
      form.append('image', imageResponse.data, { filename: 'telegram_photo.jpg' });

      const uploadResponse = await axios.post(`https://api.imgbb.com/1/upload?key=${IMGBB_API_KEY}`, form, { headers: form.getHeaders() });
      if (uploadResponse.data && uploadResponse.data.success) {
        const imageUrl = uploadResponse.data.data.url;
        if (state.step === 'awaiting_edit_images') {
          if (!state.newUrls) state.newUrls = [];
          state.newUrls.push(imageUrl);
        } else {
          const targetArray = state.step === 'awaiting_images' ? 'imageUrls' : 'qcImageUrls';
          if (!state.product[targetArray]) state.product[targetArray] = [];
          state.product[targetArray].push(imageUrl);
        }
        adminBot.sendMessage(chatId, `ფოტო აიტვირთა. გამოაგზავნეთ შემდეგი ან დაწერეთ 'done'.`);
      } else {
        throw new Error('imgbb upload failed');
      }
    } catch (e) {
      console.error('Image upload failed:', e);
      adminBot.sendMessage(chatId, `ფოტოს ატვირთვა ვერ მოხერხდა: ${e.message || e}`);
    }
  });
} else {
  console.log('ADMIN_BOT_TOKEN not set, Telegram admin features disabled.');
}

// ----------------------
// Start server
// ----------------------
app.listen(port, async () => {
  await initializeDatabase();
  console.log(`Server running on port ${port}`);
  console.log(`BASE_URL: ${BASE_URL || 'not-set'}`);
  console.log(`BOG mode: ${BOG_MODE}`);
});