// server.js — გაწმენდილი ვერსია (BOG ამოღებულია)

const express = require("express");
const bodyParser = require("body-parser");
const TelegramBot = require("node-telegram-bot-api");
const cors = require("cors");
const axios = require("axios");
const { Pool } = require("pg");

const app = express();
const port = process.env.PORT || 8080;

// === ENVIRONMENT VARIABLES ===
const ADMIN_BOT_TOKEN = process.env.ADMIN_BOT_TOKEN;
const TELEGRAM_CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID;
const TELEGRAM_GROUP_ID = process.env.TELEGRAM_GROUP_ID;
const DATABASE_URL = process.env.DATABASE_URL;

// === DATABASE CONNECTION ===
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// === DATABASE INITIALIZATION ===
const initializeDatabase = async () => {
  try {
    const client = await pool.connect();

    // პროდუქცია
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

    // შეკვეთები
    await client.query(`
      CREATE TABLE IF NOT EXISTS orders (
        order_id VARCHAR(50) PRIMARY KEY,
        customer_data JSONB,
        items JSONB,
        total_price NUMERIC(10,2),
        status VARCHAR(50) DEFAULT 'მიღებულია',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    client.release();
    console.log("✅ Database initialized successfully");
  } catch (err) {
    console.error("❌ Database initialization failed:", err);
    process.exit(1);
  }
};

// === MIDDLEWARE ===
app.use(cors());
app.use(express.static("public"));
app.use(bodyParser.json({ limit: "50mb" }));
app.use(bodyParser.urlencoded({ extended: true, limit: "50mb" }));

// === GLOBAL STATE ===
const chatSessions = new Map();

// =====================================================
// 🌐 API ROUTES
// =====================================================

// --- Root ---
app.get("/", (req, res) => {
  res.json({
    message: "LXRYTO Server is running 🚀",
    version: "BOG removed",
    endpoints: [
      "/api/products",
      "/api/submit-order",
      "/api/orders",
      "/api/admin/sales-data",
      "/api/live-chat",
      "/api/visitor",
      "/api/health",
    ],
  });
});

// --- პროდუქციის გამოტანა ---
app.get("/api/products", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM products ORDER BY id DESC");
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false });
  }
});

// --- შეკვეთის შენახვა ---
app.post("/api/submit-order", async (req, res) => {
  const { customer, items, totalPrice } = req.body;
  const orderId = `ORDER_${Date.now()}`;
  try {
    await pool.query(
      "INSERT INTO orders (order_id, customer_data, items, total_price, status) VALUES ($1,$2,$3,$4,$5)",
      [orderId, JSON.stringify(customer), JSON.stringify(items), totalPrice, "received"]
    );
    res.json({
      success: true,
      order_id: orderId,
      message: "✅ Order saved successfully (no BOG integration)",
    });
  } catch (err) {
    console.error("Error saving order:", err);
    res.status(500).json({ success: false, message: "Database error saving order" });
  }
});

// --- შეკვეთების სია ---
app.get("/api/orders", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM orders ORDER BY created_at DESC");
    res.json(result.rows);
  } catch (err) {
    console.error("Error fetching orders:", err);
    res.status(500).json({ success: false });
  }
});

// --- გაყიდვების მონაცემები ---
app.get("/api/admin/sales-data", async (req, res) => {
  try {
    const { months = 3 } = req.query;
    const dateThreshold = new Date();
    dateThreshold.setMonth(dateThreshold.getMonth() - parseInt(months));

    const revenue = await pool.query(
      "SELECT SUM(total_price) as total_revenue FROM orders WHERE created_at >= $1 AND status=$2",
      [dateThreshold, "paid"]
    );
    const sales = await pool.query(
      "SELECT COUNT(*) as total_sales FROM orders WHERE created_at >= $1 AND status=$2",
      [dateThreshold, "paid"]
    );

    res.json({
      totalRevenue: parseFloat(revenue.rows[0]?.total_revenue || 0),
      totalSales: parseInt(sales.rows[0]?.total_sales || 0),
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- Health Check ---
app.get("/api/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ status: "healthy", timestamp: new Date().toISOString() });
  } catch {
    res.status(500).json({ status: "unhealthy" });
  }
});

// =====================================================
// 💬 LIVE CHAT
// =====================================================
app.post("/api/live-chat", (req, res) => {
  const { sessionId, isNewChat, userData, message } = req.body;
  if (!sessionId) return res.status(400).json({ success: false });

  if (isNewChat) {
    chatSessions.set(sessionId, { userData, pendingMessages: [] });
    if (adminBot && TELEGRAM_GROUP_ID) {
      adminBot.sendMessage(TELEGRAM_GROUP_ID, `🔔 ახალი ჩატი: ${userData.name}`, {
        parse_mode: "Markdown",
      });
    }
  } else {
    const session = chatSessions.get(sessionId);
    if (session && adminBot && TELEGRAM_GROUP_ID) {
      adminBot.sendMessage(
        TELEGRAM_GROUP_ID,
        `💬 ${session.userData.name}: ${message}`,
        { parse_mode: "Markdown" }
      );
    }
  }
  res.json({ success: true });
});

app.get("/api/chat-response/:sessionId", (req, res) => {
  const session = chatSessions.get(req.params.sessionId);
  if (session && session.pendingMessages.length > 0) {
    res.json({ success: true, message: session.pendingMessages.shift() });
  } else res.json({ success: false });
});

// =====================================================
// 👁️ VISITOR TRACKING
// =====================================================
app.post("/api/visitor", async (req, res) => {
  if (!adminBot || !TELEGRAM_CHANNEL_ID)
    return res.json({ success: true, message: "No Telegram configured" });

  const ip = req.ip;
  const message = `👤 ახალი ვიზიტორი საიტზე: \`${ip}\``;

  try {
    await adminBot.sendMessage(TELEGRAM_CHANNEL_ID, message, { parse_mode: "Markdown" });
    res.json({ success: true });
  } catch (err) {
    console.error("Error sending visitor notification:", err);
    res.status(500).json({ success: false });
  }
});

// =====================================================
// 🤖 TELEGRAM BOT
// =====================================================
let adminBot;
if (ADMIN_BOT_TOKEN) {
  adminBot = new TelegramBot(ADMIN_BOT_TOKEN, { polling: true });
  console.log("🤖 Telegram admin bot started successfully");
} else {
  console.warn("⚠️ ADMIN_BOT_TOKEN not provided — Telegram bot disabled");
}

// =====================================================
// 🚀 SERVER START
// =====================================================
initializeDatabase().then(() => {
  app.listen(port, () => console.log(`🚀 Server running on port ${port}`));
});