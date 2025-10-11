// server.js - სრული სერვერის ლოგიკა

const express = require('express');
const bodyParser = require('body-parser');
const TelegramBot = require('node-telegram-bot-api');
const cors = require('cors');
const path = require('path');
const axios = require('axios');
const { Pool } = require('pg');
const { URLSearchParams } = require('url');

const app = express();
const port = process.env.PORT || 8080;

// --- გარემოს ცვლადები (ENV Variables) ---
// **რეკომენდაცია:** გამოიყენეთ .env ფაილი და dotenv ბიბლიოთეკა ამ ცვლადების დასაყენებლად!
const ADMIN_BOT_TOKEN = process.env.ADMIN_BOT_TOKEN || '8151755873:AAEBrslgbP49Q3FiTSKAm7fyQchNbUMVSe0'; // თქვენი ტესტ ტოკენი
const TELEGRAM_GROUP_ID = process.env.TELEGRAM_GROUP_ID || '-4644402426'; // თქვენი ჯგუფის ID
const DATABASE_URL = process.env.DATABASE_URL; // PostgreSQL Connection String

// --- BOG Payment Credentials ---
const BOG_CLIENT_ID = process.env.BOG_CLIENT_ID || 'your_bog_client_id_placeholder'; // 👈 შეცვალეთ რეალურით
const BOG_CLIENT_SECRET = process.env.BOG_CLIENT_SECRET || 'your_bog_client_secret_placeholder'; // 👈 შეცვალეთ რეალურით
const BOG_TOKEN_URL = 'https://oauth2.bog.ge/auth/realms/bog/protocol/openid-connect/token';
const BOG_ORDER_URL = 'https://api.bog.ge/api/v1/payment/ecommerce/orders';
const BASE_URL = process.env.BASE_URL || 'https://solairdropx-production.up.railway.app'; // თქვენი აპლიკაციის საჯარო მისამართი

// --- ინიციალიზაცია ---
const bot = new TelegramBot(ADMIN_BOT_TOKEN, { polling: false });
const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false } // საჭიროა Railway-სა და მსგავს ჰოსტინგებზე
});

// --- Middleware ---
app.use(cors());
app.use(bodyParser.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname)));
app.use(bodyParser.urlencoded({ extended: true }));


// ===============================================
// --- დამხმარე ფუნქციები ---
// ===============================================

/**
 * აგენერირებს უნიკალურ შეკვეთის ID-ს
 */
const generateOrderId = (prefix = 'ORD') => {
    const timestamp = Date.now().toString(36).toUpperCase();
    const random = Math.random().toString(36).substring(2, 7).toUpperCase();
    return `${prefix}_${timestamp}_${random}`;
};

/**
 * ბრუნდება BOG Access Token.
 */
let bogAccessToken = null;
let tokenExpiryTime = 0;

const getBogAccessToken = async () => {
    if (bogAccessToken && Date.now() < tokenExpiryTime) {
        return bogAccessToken;
    }

    console.log('[inf] 🔑 Requesting BOG access token...');
    try {
        const formData = new URLSearchParams();
        formData.append('grant_type', 'client_credentials');
        formData.append('client_id', BOG_CLIENT_ID);
        formData.append('client_secret', BOG_CLIENT_SECRET);
        
        const response = await axios.post(BOG_TOKEN_URL, formData.toString(), {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            }
        });

        console.log(`[inf] 📨 BOG token response status: ${response.status}`);
        bogAccessToken = response.data.access_token;
        // ვადა გაუვა 5 წუთით ადრე
        tokenExpiryTime = Date.now() + (response.data.expires_in * 1000) - (5 * 60 * 1000); 
        console.log('[inf] ✅ BOG access token received successfully');
        return bogAccessToken;

    } catch (error) {
        console.error(`[err] ❌ BOG Token Error: ${error.message}`);
        throw new Error('Failed to get BOG access token');
    }
};

/**
 * აგზავნის შეტყობინებას Telegram-ში.
 */
const sendTelegramNotification = async (message, chatId = TELEGRAM_GROUP_ID) => {
    if (!chatId) {
        console.warn('❌ Telegram group ID is not set. Cannot send notification.');
        return;
    }
    try {
        await bot.sendMessage(chatId, message, { parse_mode: 'HTML' });
        console.log(`[inf] 📢 Telegram notification sent to ${chatId}`);
    } catch (error) {
        console.error('❌ Failed to send Telegram notification:', error.message);
    }
};


// ===============================================
// --- მონაცემთა ბაზის ფუნქციები ---
// ===============================================

/**
 * მონაცემთა ბაზის სქემის ინიციალიზაცია.
 */
const initializeDatabase = async () => {
    if (!DATABASE_URL) {
        console.log('❌ DATABASE_URL is not set. Database operations will fail.');
        return;
    }
    try {
        const client = await pool.connect();
        await client.query(`
            CREATE TABLE IF NOT EXISTS orders (
                id SERIAL PRIMARY KEY,
                order_id VARCHAR(50) UNIQUE NOT NULL,
                name VARCHAR(255) NOT NULL,
                phone VARCHAR(50) NOT NULL,
                address TEXT NOT NULL,
                email VARCHAR(255),
                city VARCHAR(100),
                total_amount NUMERIC(10, 2) NOT NULL,
                items JSONB NOT NULL,
                status VARCHAR(50) NOT NULL DEFAULT 'pending',
                bog_order_id VARCHAR(255),
                bog_payment_id VARCHAR(255),
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );
        `);
        client.release();
        console.log('✅ Database initialized successfully.');
    } catch (error) {
        console.error('❌ Database initialization failed:', error);
    }
};

/**
 * ინახავს ახალ შეკვეთას მონაცემთა ბაზაში.
 */
const saveNewOrder = async ({ dbOrderId, name, phone, address, email, city, totalAmount, items }) => {
    try {
        const result = await pool.query(
            `INSERT INTO orders (order_id, name, phone, address, email, city, total_amount, items, status)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'payment_pending')
             RETURNING *`,
            [dbOrderId, name, phone, address, email, city, totalAmount, items]
        );
        return result.rows[0];
    } catch (error) {
        console.error('❌ Database Save Error:', error);
        throw new Error('Failed to save order to database');
    }
};

/**
 * ანახლებს შეკვეთის სტატუსს.
 */
const updateOrderStatus = async (orderId, status, bogOrderId = null, bogPaymentId = null) => {
    try {
        let query = `UPDATE orders SET status = $2, updated_at = CURRENT_TIMESTAMP`;
        const params = [orderId, status];
        let paramIndex = 3;

        if (bogOrderId) {
            query += `, bog_order_id = $${paramIndex++}`;
            params.push(bogOrderId);
        }
        if (bogPaymentId) {
            query += `, bog_payment_id = $${paramIndex++}`;
            params.push(bogPaymentId);
        }

        query += ` WHERE order_id = $1 RETURNING *`;

        const result = await pool.query(query, params);
        if (result.rows.length === 0) {
            console.warn(`[warn] Order not found for ID: ${orderId}`);
        }
        return result.rows[0];
    } catch (error) {
        console.error('❌ Database Update Error:', error);
        return null;
    }
};


// ===============================================
// --- API ენდპოინტები ---
// ===============================================

// სტატიკური ფაილების სერვინგი (index.php-ის ჩათვლით)
app.get('/', (req, res) => {
    // თუ იყენებთ index.php-ს, Express-მა უნდა მიაწოდოს ის
    res.sendFile(path.join(__dirname, 'index.php'));
});

// სერვერის ჯანმრთელობის შემოწმება
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', serverTime: new Date().toISOString() });
});


/**
 * შეკვეთის წარდგენა და BOG გადახდის ინიციალიზაცია
 */
app.post('/api/submit-order', async (req, res) => {
    console.log('[inf] 📦 Received order submission request');
    // მიიღეთ მონაცემები ფრონტენდიდან
    const { name, phone, address, email, city, amount, items } = req.body;
    const totalAmount = parseFloat(amount);
    const dbOrderId = generateOrderId();

    if (!name || !phone || !address || !totalAmount || !items || items.length === 0) {
        return res.status(400).json({ success: false, message: 'Missing required order details.' });
    }

    try {
        // 1. შეკვეთის შენახვა მონაცემთა ბაზაში
        await saveNewOrder({ dbOrderId, name, phone, address, email, city, totalAmount, items: JSON.stringify(items) });
        console.log(`[inf] 🆔 Generated order ID: ${dbOrderId}`);
        console.log('[inf] ✅ Order saved to database successfully');


        // 2. BOG Access Token-ის მიღება
        const accessToken = await getBogAccessToken();


        // 3. BOG API-სთვის Payload-ის მომზადება
        // BOG-ს სჭირდება თანხები თეთრებში (cents)
        const bogItems = items.map(item => ({
            name: item.name || 'Product',
            quantity: 1, 
            price: Math.round(parseFloat(item.price) * 100), 
            total_price: Math.round(parseFloat(item.price) * 100)
        }));

        const amountInCents = Math.round(totalAmount * 100);

        // 💡 ფიქსი: orderPayload ობიექტის შესწორება BOG-ის "purchase_units" მოთხოვნის მიხედვით
        const orderPayload = {
            currency: "GEL",
            capture_method: "AUTO",
            callback_url: `${BASE_URL}/api/payment-callback`,
            redirect_urls: {
                success_url: `${BASE_URL}/success?order_id=${dbOrderId}`,
                failure_url: `${BASE_URL}/fail?order_id=${dbOrderId}`
            },
            extra: {
                order_id: dbOrderId
            },
            // **ძირითადი ფიქსი**: დამატებულია purchase_units მასივი
            purchase_units: [{
                amount: {
                    currency: "GEL",
                    value: amountInCents // ჯამური თანხა (თეთრებში)
                },
                items: bogItems // პროდუქტების დეტალური ჩამონათვალი
            }]
        };

        console.log(`[inf] 🌐 Base URL for callbacks: ${BASE_URL}`);
        console.log(`[inf] 🔄 Sending BOG order payload...`);


        // 4. BOG გადახდის ინიცირება
        const bogResponse = await axios.post(BOG_ORDER_URL, orderPayload, {
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json'
            }
        });

        const { id: bogOrderId, payment_link } = bogResponse.data;
        
        // 5. მონაცემთა ბაზის განახლება BOG ID-ით
        await updateOrderStatus(dbOrderId, 'payment_initiated', bogOrderId);

        console.log(`[inf] ✅ BOG order created. ID: ${bogOrderId}`);
        
        // 6. კლიენტისთვის გადახდის ლინკის დაბრუნება
        res.json({
            success: true,
            order_id: dbOrderId,
            payment_url: payment_link
        });

    } catch (error) {
        console.error('[err] ❌ Order Submission Error:', error);
        
        const errorMessage = error.response?.data?.message || error.message;

        // BOG შეცდომის დეტალების დალოგვა
        if (error.response) {
            console.error(`[err] ❌ BOG Payment Submission Error Details:`);
            console.error(`[err] Error message: ${error.message}`);
            console.error(`[err] Response status: ${error.response.status}`);
            // შეცდომის ჩვენება კლიენტისთვისაც
            console.error(`[err] Response data: ${JSON.stringify(error.response.data)}`); 
            
            // სტატუსის განახლება წარუმატებლობის შემთხვევაში
            if (dbOrderId) {
                await updateOrderStatus(dbOrderId, 'payment_init_failed');
                console.log('[inf] 🔄 Order status updated to payment_init_failed');
            }
        }

        res.status(500).json({
            success: false,
            message: `Payment initialization failed: ${errorMessage}`,
            error_code: error.response?.status || 500
        });
    }
});


/**
 * BOG Callback ენდპოინტი - აქ მოდის შეტყობინება გადახდის სტატუსის შესახებ
 */
app.post('/api/payment-callback', async (req, res) => {
    console.log('[inf] 🔔 Received BOG Payment Callback');
    const { order_id: bogOrderId, status, payment_id: bogPaymentId, extra } = req.body;
    const dbOrderId = extra?.order_id; // ჩვენი შიდა ID, რომელიც extra ველში გავაგზავნეთ
    let newStatus = 'unknown';
    let telegramMessage = '';

    if (!dbOrderId) {
        console.error('❌ Callback Error: Missing internal order ID in extra field');
        return res.status(400).send('Missing order ID');
    }

    try {
        const currentOrder = await pool.query('SELECT * FROM orders WHERE order_id = $1', [dbOrderId]);
        if (currentOrder.rows.length === 0) {
            console.error(`❌ Callback Error: Order not found for internal ID: ${dbOrderId}`);
            return res.status(404).send('Order not found');
        }
        const orderData = currentOrder.rows[0];
        
        console.log(`[inf] Processing Order: ${dbOrderId} with BOG Status: ${status}`);

        // სტატუსის დამუშავება
        if (status === 'S' || status === 'SUCCESS') {
            newStatus = 'paid';
            telegramMessage = `✅ **ახალი შეკვეთა მიღებულია!**\n\n`
                            + `**ID:** ${dbOrderId}\n`
                            + `**მყიდველი:** ${orderData.name} (${orderData.phone})\n`
                            + `**თანხა:** ${orderData.total_amount} GEL\n`
                            + `**სტატუსი:** ✅ გადახდილი\n`
                            + `**BOG ID:** ${bogOrderId}\n`
                            + `**მისამართი:** ${orderData.city || 'N/A'}, ${orderData.address}`;
        } else if (status === 'F' || status === 'FAIL') {
            newStatus = 'payment_failed';
            telegramMessage = `❌ **გადახდა ვერ მოხერხდა**\n\n`
                            + `**ID:** ${dbOrderId}\n`
                            + `**მყიდველი:** ${orderData.name} (${orderData.phone})\n`
                            + `**თანხა:** ${orderData.total_amount} GEL\n`
                            + `**სტატუსი:** ❌ გადახდა ვერ მოხერხდა`;
        } else {
            newStatus = `bog_${status.toLowerCase()}`;
        }

        // მონაცემთა ბაზის განახლება
        await updateOrderStatus(dbOrderId, newStatus, bogOrderId, bogPaymentId);
        
        // Telegram-ის შეტყობინება
        if (telegramMessage) {
            await sendTelegramNotification(telegramMessage);
        }

        console.log(`[inf] ✅ Order ${dbOrderId} status updated to: ${newStatus}`);
        res.status(200).send('Callback received and processed');

    } catch (error) {
        console.error(`❌ Error processing BOG callback for ${dbOrderId}:`, error);
        res.status(500).send('Internal Server Error');
    }
});


// ===============================================
// --- სერვერის გაშვება ---
// ===============================================
app.listen(port, async () => {
  console.log(`🚀 Server is running on port ${port}`);
  
  // მონაცემთა ბაზის ინიციალიზაცია
  await initializeDatabase();
  
  // BOG კავშირის ტესტი
  if (BOG_CLIENT_ID !== '10001710' && BOG_CLIENT_SECRET !== 'C9Dbowd9pOVt') {
    await testBogConnection();
    console.log(`💳 BOG Payment system integration: CONFIGURED`);
  } else {
    console.log('❌ BOG credentials missing or placeholder used - payment system will not work');
  }
  
  console.log(`🌐 Available endpoints:`);
  console.log(`   GET  / - Main page (serves index.php)`);
  console.log(`   POST /api/submit-order - Order submission & BOG init`);
  console.log(`   POST /api/payment-callback - BOG callback handler`);
});
