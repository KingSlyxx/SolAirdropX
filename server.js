// server.js (განახლებული ვერსია BOG გადახდის ფიქსებით)

const express = require('express');
const bodyParser = require('body-parser');
const TelegramBot = require('node-telegram-bot-api');
const cors = require('cors');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');
const { Pool } = require('pg');
const { URLSearchParams } = require('url');

const app = express();
const port = process.env.PORT || 8080;

// --- გარემოს ცვლადები (ENV Variables) ---
const ADMIN_BOT_TOKEN = process.env.ADMIN_BOT_TOKEN || '8151755873:AAEBrslgbP49Q3FiTSKAm7fyQchNbUMVSe0';
const TELEGRAM_CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID;
const TELEGRAM_GROUP_ID = process.env.TELEGRAM_GROUP_ID || '-4644402426';
const IMGBB_API_KEY = process.env.IMGBB_API_KEY;
const DATABASE_URL = process.env.DATABASE_URL;

// --- BOG Payment Credentials ---
const BOG_CLIENT_ID = process.env.BOG_CLIENT_ID;
const BOG_CLIENT_SECRET = process.env.BOG_CLIENT_SECRET;
const BOG_TOKEN_URL = 'https://oauth2.bog.ge/auth/realms/bog/protocol/openid-connect/token';
const BOG_ORDER_URL = 'https://api.bog.ge/payments/v1/checkout';

// --- PostgreSQL ბაზასთან კავშირის დამყარება ---
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// --- DB ინიციალიზაცია ---
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
        console.log('Products table is ready.');

        await client.query(`
            CREATE TABLE IF NOT EXISTS orders (
                order_id VARCHAR(50) PRIMARY KEY, 
                bog_order_id VARCHAR(50) UNIQUE,  
                customer_data JSONB,
                items JSONB,
                total_price NUMERIC(10, 2),
                status VARCHAR(50) DEFAULT 'მიღებულია',
                created_at TIMESTAMPTZ DEFAULT NOW()
            );
        `);
        console.log('Orders table is ready.');
        client.release();
    } catch (err) {
        console.error('Failed to initialize database:', err);
        process.exit(1);
    }
};

// --- Middleware ---
app.use(cors());
app.use(express.static('public'));
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '50mb' }));
app.set('trust proxy', true);

// --- Global State for Telegram Bot ---
const userState = {};
const chatSessions = new Map();

// --- Helper Functions ---
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
    gender: 'მიუთითეთ ახალი სქესი (women ან men):',
    sizes: 'შეიყვანეთ ახალი ზომები მძიმით გამოყოფით (მაგ: S,M,L):',
    image_urls: "ატვირთეთ ახალი ძირითადი ფოტო(ები). ძველები წაიშლება. დასრულებისას დაწერეთ 'done'.",
    qc_image_urls: "ატვირთეთ ახალი QC ფოტო(ები). ძველები წაიშლება. დასრულებისას დაწერეთ 'done'."
};

// BOG კავშირის ტესტი სერვერის გაშვებისას
const testBogConnection = async () => {
    try {
        console.log('🔧 Testing BOG API connection...');
        
        // შეამოწმეთ კრედენციალები
        if (!BOG_CLIENT_ID || !BOG_CLIENT_SECRET) {
            console.log('❌ BOG credentials missing');
            return {
                success: false,
                message: 'BOG credentials are missing',
                credentials_configured: false
            };
        }

        const tokenData = new URLSearchParams({
            'grant_type': 'client_credentials',
            'client_id': BOG_CLIENT_ID,
            'client_secret': BOG_CLIENT_SECRET
        });

        const response = await axios.post(BOG_TOKEN_URL, tokenData.toString(), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            timeout: 10000
        });

        if (response.data.access_token) {
            console.log('✅ BOG API connection test: SUCCESS');
            return {
                success: true,
                message: 'BOG connection successful',
                token_received: true,
                credentials_configured: true
            };
        } else {
            console.log('❌ BOG API connection test: FAILED - no token received');
            return {
                success: false,
                message: 'No access token received from BOG',
                token_received: false,
                credentials_configured: true
            };
        }
    } catch (error) {
        console.error('❌ BOG API connection test: FAILED -', error.message);
        console.log('💡 Please check your BOG credentials and network connectivity');
        return {
            success: false,
            message: error.message,
            token_received: false,
            credentials_configured: !!(BOG_CLIENT_ID && BOG_CLIENT_SECRET),
            error_details: error.response?.data || error.code
        };
    }
};

// ===============================================
// --- API ენდპოინტები ---
// ===============================================

// --- ძირითადი ენდპოინტი სერვერის სტატუსისთვის ---
app.get('/', (req, res) => {
    res.json({
        message: 'LXRYTO Server is running',
        version: '1.0',
        endpoints: {
            products: '/api/products',
            submit_order: '/api/submit-order',
            test_bog: '/api/test-bog',
            orders: '/api/orders',
            admin_sales: '/api/admin/sales-data',
            health: '/api/health'
        },
        bog_configured: !!(BOG_CLIENT_ID && BOG_CLIENT_SECRET)
    });
});

// --- 1. პროდუქციის გამოტანა ---
app.get('/api/products', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM products ORDER BY id DESC');
        const products = result.rows.map(formatProductFromDb); 
        res.json(products);
    } catch (err) {
        console.error('API /api/products error:', err);
        res.status(500).json({ success: false, message: 'Could not fetch products' });
    }
});

// --- 2. შეკვეთის გაგზავნა და BOG გადახდის ინიციალიზაცია ---
app.post('/api/submit-order', async (req, res) => {
    console.log('📦 Received order submission request');
    const orderData = req.body;
    const { customer, items, totalPrice } = orderData;
    const amount = totalPrice;
    
    const dbOrderId = `ORDER_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`.toUpperCase();
    console.log('🆔 Generated order ID:', dbOrderId);

    // 1. შეკვეთის შენახვა ბაზაში (payment_pending სტატუსით)
    try {
        await pool.query(
            'INSERT INTO orders (order_id, customer_data, items, total_price, status) VALUES ($1, $2, $3, $4, $5)',
            [dbOrderId, JSON.stringify(customer), JSON.stringify(items), totalPrice, 'payment_pending']
        );
        console.log('✅ Order saved to database successfully');
    } catch (dbError) {
        console.error('❌ DB Error saving order:', dbError);
        return res.status(500).json({ 
            success: false, 
            error: 'Failed to save order to database',
            order_id: dbOrderId
        });
    }

    try {
        // --- 2. BOG Token მიღება ---
        console.log('🔑 Requesting BOG access token...');
        
        // შეამოწმეთ კრედენციალები
        if (!BOG_CLIENT_ID || !BOG_CLIENT_SECRET) {
            throw new Error('BOG credentials are not configured');
        }

        const tokenData = new URLSearchParams({
            'grant_type': 'client_credentials',
            'client_id': BOG_CLIENT_ID,
            'client_secret': BOG_CLIENT_SECRET
        });

        console.log('🔐 Using BOG credentials:', {
            client_id: BOG_CLIENT_ID.substring(0, 5) + '...',
            token_url: BOG_TOKEN_URL
        });

        const tokenResponse = await axios.post(BOG_TOKEN_URL, tokenData.toString(), {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            timeout: 15000
        });

        console.log('📨 BOG token response status:', tokenResponse.status);
        
        if (!tokenResponse.data.access_token) {
            console.error('❌ No access token in BOG response:', tokenResponse.data);
            throw new Error('No access token received from BOG');
        }

        const token = tokenResponse.data.access_token;
        console.log('✅ BOG access token received successfully');

        // --- 3. შეკვეთის შექმნა BOG-ში ---
        const host = req.headers.host;
        const protocol = req.headers['x-forwarded-proto'] || req.protocol;
        const BASE_URL = `${protocol}://${host}`;

        console.log('🌐 Base URL for callbacks:', BASE_URL);

        // გაასწორეთ items სტრუქტურა BOG-ის მოთხოვნების შესაბამისად
        const bogItems = items.map(item => ({
            name: item.name?.ge || item.name || 'Product',
            quantity: 1,
            price: parseFloat(item.price),
            total_price: parseFloat(item.price)
        }));

        const orderPayload = {
            amount: parseFloat(amount),
            currency: "GEL",
            capture_method: "AUTO",
            items: bogItems,
            callback_url: `${BASE_URL}/api/payment-callback`,
            redirect_urls: {
                success_url: `${BASE_URL}/success?order_id=${dbOrderId}`,
                failure_url: `${BASE_URL}/fail?order_id=${dbOrderId}`
            },
            extra: {
                order_id: dbOrderId
            }
        };

        console.log('🔄 Sending order to BOG API:', JSON.stringify(orderPayload, null, 2));

        const orderResponse = await axios.post(BOG_ORDER_URL, orderPayload, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            },
            timeout: 20000
        });

        console.log('📨 BOG order creation response status:', orderResponse.status);
        console.log('📨 BOG order creation response data:', JSON.stringify(orderResponse.data, null, 2));

        // გაასწორეთ პასუხის დამუშავება
        const bogOrderId = orderResponse.data.order_id;
        const paymentLink = orderResponse.data._links?.redirect?.href || 
                          orderResponse.data.links?.payment_url ||
                          orderResponse.data.redirect_url ||
                          orderResponse.data.payment_url;

        console.log('🔗 Extracted payment link:', paymentLink);
        console.log('🆔 BOG Order ID:', bogOrderId);

        if (paymentLink && bogOrderId) {
            // 4. BOG ID-ის შენახვა ბაზაში
            await pool.query(
                'UPDATE orders SET bog_order_id = $1 WHERE order_id = $2',
                [bogOrderId, dbOrderId]
            );

            console.log('✅ BOG order created successfully, redirecting to:', paymentLink);
            
            res.json({ 
                success: true, 
                redirect_url: paymentLink,
                order_id: dbOrderId,
                bog_order_id: bogOrderId
            });
        } else {
            console.error('❌ Missing payment link or BOG Order ID in response');
            console.error('Full response:', orderResponse.data);
            throw new Error('Failed to get payment redirect URL or BOG Order ID from response');
        }

    } catch (error) {
        console.error('❌ BOG Payment Submission Error Details:');
        console.error('Error message:', error.message);
        console.error('Error code:', error.code);
        
        if (error.response) {
            console.error('Response status:', error.response.status);
            console.error('Response data:', JSON.stringify(error.response.data, null, 2));
            console.error('Response headers:', error.response.headers);
        } else if (error.request) {
            console.error('No response received. Request details:', error.request._currentUrl || error.request);
        }
        
        console.error('Stack trace:', error.stack);

        // სტატუსის განახლება წარუმატებლობის შემთხვევაში
        try {
            await pool.query('UPDATE orders SET status = $1 WHERE order_id = $2', ['payment_init_failed', dbOrderId]);
            console.log('🔄 Order status updated to payment_init_failed');
        } catch (updateError) {
            console.error('❌ Failed to update order status:', updateError);
        }

        // დეტალური error response
        const errorResponse = {
            success: false,
            error: 'Order submission failed. Please try again later.',
            order_id: dbOrderId,
            details: error.response?.data || error.message,
            credentials_configured: !!(BOG_CLIENT_ID && BOG_CLIENT_SECRET)
        };

        res.status(500).json(errorResponse);
    }
});

// --- 3. BOG Callback / Webhook Endpoint ---
app.post('/api/payment-callback', async (req, res) => {
    try {
        const { order_id, status } = req.body;
        
        console.log('🔄 Received BOG callback:', { order_id, status });
        
        if (!order_id) {
            console.error('❌ Missing BOG Order ID in callback');
            return res.status(400).send('Missing BOG Order ID');
        }

        // 1. შეკვეთის მოძიება BOG ID-ის გამოყენებით
        const orderResult = await pool.query('SELECT order_id FROM orders WHERE bog_order_id = $1', [order_id]);
        const order = orderResult.rows.length > 0 ? orderResult.rows[0] : null;

        if (!order) {
             console.error(`❌ Callback received for unknown BOG Order ID: ${order_id}`);
             return res.status(200).send('Order ID not found in DB');
        }
        
        const dbOrderId = order.order_id;
        
        let newStatus = 'failed';
        if (status === 'success') {
            newStatus = 'paid';
        } else if (status === 'pending') {
            newStatus = 'pending';
        } else if (status === 'canceled') {
            newStatus = 'canceled';
        }

        console.log(`🔄 Updating order ${dbOrderId} status to: ${newStatus}`);

        // 2. შეკვეთის სტატუსის განახლება
        await pool.query(
            'UPDATE orders SET status = $1 WHERE order_id = $2',
            [newStatus, dbOrderId]
        );

        // 3. ნოტიფიკაცია Telegram-ში
        if (adminBot && TELEGRAM_GROUP_ID) {
            let message = '';
            if (newStatus === 'paid') {
                 message = `✅ **გადახდა დადასტურდა!**\n\n*შეკვეთის ID:* ${dbOrderId}\n*BOG ID:* \`${order_id}\``;
            } else if (newStatus === 'failed' || newStatus === 'canceled') {
                 message = `❌ **გადახდა ${newStatus}**\n\n*შეკვეთის ID:* ${dbOrderId}\n*BOG ID:* \`${order_id}\``;
            }

            if (message) {
                 await adminBot.sendMessage(TELEGRAM_GROUP_ID, message, { parse_mode: 'Markdown' })
                    .catch(err => console.error('Failed to send Telegram notification:', err));
            }
        }
        
        res.status(200).json({ success: true, status: newStatus });
    } catch (error) {
        console.error('❌ Payment callback error:', error);
        res.status(500).json({ success: false, error: 'Callback processing failed' });
    }
});

// --- 4. წარმატებული გადახდის გვერდი ---
app.get('/success', async (req, res) => {
    const { order_id } = req.query;
    
    console.log('✅ Payment success page accessed for order:', order_id);
    
    if (order_id) {
        try {
            await pool.query(
                'UPDATE orders SET status = $1 WHERE order_id = $2',
                ['paid', order_id]
            );
            console.log(`✅ Order ${order_id} status updated to paid`);
        } catch (error) {
            console.error('❌ Error updating order status:', error);
        }
    }
    
    res.send(`
        <html>
            <head>
                <title>გადახდა წარმატებულია</title>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <style>
                    body { 
                        font-family: Arial, sans-serif; 
                        display: flex; 
                        justify-content: center; 
                        align-items: center; 
                        height: 100vh; 
                        margin: 0; 
                        background-color: #f5f5f5;
                    }
                    .container { 
                        text-align: center; 
                        background: white; 
                        padding: 40px; 
                        border-radius: 10px; 
                        box-shadow: 0 4px 12px rgba(0,0,0,0.1);
                        max-width: 400px;
                    }
                    h1 { color: green; margin-bottom: 20px; }
                    p { margin: 10px 0; color: #333; }
                    a { 
                        color: #007bff; 
                        text-decoration: none; 
                        font-weight: bold; 
                    }
                    a:hover { text-decoration: underline; }
                </style>
            </head>
            <body>
                <div class="container">
                    <h1>✅ გადახდა წარმატებულია!</h1>
                    <p>გმადლობთ შეკვეთისთვის.</p>
                    <p>თქვენი შეკვეთის ID: <strong>${order_id || 'Unknown'}</strong></p>
                    <p>შეკვეთის სტატუსის შესამოწმებლად გადადით <a href="/">მთავარ გვერდზე</a>.</p>
                </div>
            </body>
        </html>
    `);
});

// --- 5. წარუმატებელი გადახდის გვერდი ---
app.get('/fail', async (req, res) => {
    const { order_id } = req.query;
    
    console.log('❌ Payment failure page accessed for order:', order_id);
    
    if (order_id) {
        try {
            await pool.query(
                'UPDATE orders SET status = $1 WHERE order_id = $2',
                ['failed', order_id]
            );
            console.log(`🔄 Order ${order_id} status updated to failed`);
        } catch (error) {
            console.error('❌ Error updating order status:', error);
        }
    }
    
    res.send(`
        <html>
            <head>
                <title>გადახდა ვერ მოხერხდა</title>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <style>
                    body { 
                        font-family: Arial, sans-serif; 
                        display: flex; 
                        justify-content: center; 
                        align-items: center; 
                        height: 100vh; 
                        margin: 0; 
                        background-color: #f5f5f5;
                    }
                    .container { 
                        text-align: center; 
                        background: white; 
                        padding: 40px; 
                        border-radius: 10px; 
                        box-shadow: 0 4px 12px rgba(0,0,0,0.1);
                        max-width: 400px;
                    }
                    h1 { color: red; margin-bottom: 20px; }
                    p { margin: 10px 0; color: #333; }
                    a { 
                        color: #007bff; 
                        text-decoration: none; 
                        font-weight: bold; 
                    }
                    a:hover { text-decoration: underline; }
                </style>
            </head>
            <body>
                <div class="container">
                    <h1>❌ გადახდა ვერ მოხერხდა</h1>
                    <p>გადახდის პროცესი ვერ შესრულდა.</p>
                    <p>თქვენი შეკვეთის ID: <strong>${order_id || 'Unknown'}</strong></p>
                    <p>გთხოვთ სცადოთ თავიდან ან დაგვიკავშირდეთ.</p>
                    <p><a href="/">დაბრუნება მთავარ გვერდზე</a></p>
                </div>
            </body>
        </html>
    `);
});

// --- 6. BOG კავშირის ტესტის ენდპოინტი ---
app.get('/api/test-bog', async (req, res) => {
    try {
        console.log('🧪 Testing BOG connection via API endpoint...');
        const result = await testBogConnection();
        
        res.json({
            success: result.success,
            message: result.message,
            credentials_configured: !!(BOG_CLIENT_ID && BOG_CLIENT_SECRET),
            environment: process.env.NODE_ENV || 'development',
            timestamp: new Date().toISOString(),
            details: result
        });
    } catch (error) {
        console.error('Error in /api/test-bog:', error);
        res.status(500).json({ 
            success: false, 
            error: error.message,
            credentials_configured: !!(BOG_CLIENT_ID && BOG_CLIENT_SECRET),
            timestamp: new Date().toISOString()
        });
    }
});

// --- 7. სერვერის ჯანმრთელობის შემოწმება ---
app.get('/api/health', async (req, res) => {
    try {
        // ბაზასთან კავშირის შემოწმება
        await pool.query('SELECT 1');
        
        res.json({
            status: 'healthy',
            database: 'connected',
            bog_configured: !!(BOG_CLIENT_ID && BOG_CLIENT_SECRET),
            timestamp: new Date().toISOString(),
            uptime: process.uptime(),
            environment: process.env.NODE_ENV || 'development'
        });
    } catch (error) {
        console.error('Health check failed:', error);
        res.status(500).json({
            status: 'unhealthy',
            database: 'disconnected',
            error: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

// ===============================================
// --- Telegram Bot Setup & Handlers ---
// ===============================================

let adminBot;
if (ADMIN_BOT_TOKEN) {
    adminBot = new TelegramBot(ADMIN_BOT_TOKEN, { polling: true });
    console.log('Admin Bot for product management and Live Chat is running...');
    
    const mainMenuKeyboard = { keyboard: [[{ text: 'პროდუქტების ნახვა' }], [{ text: 'პროდუქტის დამატება' }], [{ text: 'გაყიდვების მონაცემები' }]], resize_keyboard: true };
    const salesKeyboard = { keyboard: [[{ text: '/sales 3' }, { text: '/recent 5' }], [{ text: 'მთავარი მენიუ' }]], resize_keyboard: true };
    const resetState = (chatId) => delete userState[chatId];
    
    // --- /start ბრძანების დამმუშავებელი ---
    adminBot.onText(/\/start/, (msg) => {
        resetState(msg.chat.id);
        adminBot.sendMessage(msg.chat.id, 'მოგესალმებით! აირჩიეთ მოქმედება:', { reply_markup: mainMenuKeyboard });
    });
    
    // --- გაყიდვების მონაცემები ღილაკზე რეაგირება ---
    adminBot.onText(/გაყიდვების მონაცემები/, (msg) => {
        resetState(msg.chat.id);
        adminBot.sendMessage(msg.chat.id, 'აირჩიეთ გაყიდვების ბრძანება:', { reply_markup: salesKeyboard });
    });
    
    // --- /sales ბრძანების დამმუშავებელი ---
    adminBot.onText(/\/sales\s?(\d*)/, async (msg, match) => {
        const chatId = msg.chat.id;
        const months = match[1] || 3; 
        
        try {
            const response = await axios.get(`https://${req.headers.host}/api/admin/sales-data?months=${months}`);
            const data = response.data;

            const message = `
📊 **გაყიდვების მონაცემები (ბოლო ${months} თვე)**
------------------------------------
💵 **საერთო შემოსავალი:** ${data.totalRevenue.toFixed(2)} GEL
📦 **გაყიდვების რაოდენობა:** ${data.totalSales}
            `;
            adminBot.sendMessage(chatId, message);

        } catch (error) {
            console.error('Error fetching sales data for Telegram:', error.message);
            adminBot.sendMessage(chatId, '❌ შეცდომა მონაცემების მიღებისას. სცადეთ მოგვიანებით.');
        }
    });

    // --- /recent ბრძანების დამმუშავებელი ---
    adminBot.onText(/\/recent\s?(\d*)/, async (msg, match) => {
        const chatId = msg.chat.id;
        const limit = match[1] ? parseInt(match[1]) : 5; 

        try {
            const recentSalesQuery = `
                SELECT order_id, total_price, created_at, customer_data
                FROM orders 
                WHERE status = $1 
                ORDER BY created_at DESC 
                LIMIT $2
            `;
            const result = await pool.query(recentSalesQuery, ['paid', limit]);
            const sales = result.rows;

            if (sales.length === 0) {
                return adminBot.sendMessage(chatId, 'ბოლო გაყიდვები ვერ მოიძებნა.');
            }

            const salesList = sales.map(s => {
                const customer = JSON.parse(s.customer_data);
                const date = new Date(s.created_at).toLocaleString('ka-GE');
                return `
ID: \`${s.order_id}\`
ჯამი: ${s.total_price.toFixed(2)} GEL
თარიღი: ${date}
მომხმარებელი: ${customer.lastName || ''}
                `;
            }).join('\n---\n');

            const message = `
📦 **ბოლო ${sales.length} წარმატებული გაყიდვა:**
--------------------------------
${salesList}
            `;
            adminBot.sendMessage(chatId, message, { parse_mode: 'HTML' });

        } catch (error) {
            console.error('Error fetching recent sales for Telegram:', error);
            adminBot.sendMessage(chatId, '❌ შეცდომა ბოლო გაყიდვების მიღებისას.');
        }
    });

    // --- პროდუქტების ნახვა / მართვის ლოგიკა ---
    adminBot.onText(/პროდუქტების ნახვა/, (msg) => {
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

    adminBot.onText(/პროდუქტის დამატება/, (msg) => {
        userState[msg.chat.id] = { step: 'awaiting_name_ge', product: {} };
        adminBot.sendMessage(msg.chat.id, 'შეიყვანეთ პროდუქტის სახელი (ქართულად):', { reply_markup: { force_reply: true } });
    });
    
    adminBot.onText(/მთავარი მენიუ/, (msg) => {
        resetState(msg.chat.id);
        adminBot.sendMessage(msg.chat.id, 'მთავარი მენიუ:', { reply_markup: mainMenuKeyboard });
    });

    adminBot.on('message', async (msg) => {
        // Live Chat Response Handling
        if (msg.reply_to_message && msg.reply_to_message.from.is_bot && msg.text) {
            const originalMessage = msg.reply_to_message.text;
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
            // Product ID for management
            if (state.step === 'awaiting_product_id_for_manage') {
                const productId = parseInt(msg.text, 10);
                if (isNaN(productId)) {
                    return adminBot.sendMessage(chatId, "არასწორი ფორმატი. გთხოვთ შეიყანოთ მხოლოდ პროდუქტის ID (ციფრი).");
                }
                const result = await pool.query('SELECT * FROM products WHERE id = $1', [productId]);
                if (result.rows.length === 0) {
                    return adminBot.sendMessage(chatId, `პროდუქტი ID: ${productId} ვერ მოიძებნა.`);
                }
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

            // Product Editing Input
            if (state.step === 'awaiting_edit_input') {
                let value = msg.text;
                if (['price', 'old_price'].includes(state.field)) {
                    value = parseFloat(value);
                    if (state.field === 'old_price' && value <= 0) value = null;
                }
                if (state.field === 'sizes') { value = msg.text.split(',').map(s => s.trim().toUpperCase()); }
                await pool.query(`UPDATE products SET ${state.field} = $1 WHERE id = $2`, [value, state.productId]);
                adminBot.sendMessage(chatId, `✅ ველი წარმატებით განახლდა.`);
                resetState(chatId);
                return;
            }
            // Product Editing Images (Done)
            if (state.step === 'awaiting_edit_images' && msg.text.toLowerCase() === 'done') {
                if (!state.newUrls || state.newUrls.length === 0) { return adminBot.sendMessage(chatId, "გთხოვთ, მინიმუმ ერთი ახალი ფოტო ატვირთოთ ან დაწერეთ 'cancel'."); }
                await pool.query(`UPDATE products SET ${state.field} = $1 WHERE id = $2`, [state.newUrls, state.productId]);
                adminBot.sendMessage(chatId, `✅ ფოტო(ები) წარმატებით განახლდა.`);
                resetState(chatId);
                return;
            }
            
            // Product Addition Flow
            switch (state.step) {
                case 'awaiting_name_ge': state.product.name_ge = msg.text; state.step = 'awaiting_name_en'; adminBot.sendMessage(chatId, 'შეიყვანეთ პროდუქტის სახელი (ინგლისურად):', { reply_markup: { force_reply: true } }); break;
                case 'awaiting_name_en': state.product.name_en = msg.text; state.step = 'awaiting_price'; adminBot.sendMessage(chatId, 'შეიყვანეთ ფასი (მაგ: 129.99):', { reply_markup: { force_reply: true } }); break;
                case 'awaiting_price': state.product.price = parseFloat(msg.text); state.step = 'awaiting_old_price'; adminBot.sendMessage(chatId, 'შეიყვანეთ ძველი ფასი (თუ არ აქვს, დაწერეთ 0):', { reply_markup: { force_reply: true } }); break;
                case 'awaiting_old_price': state.product.old_price = parseFloat(msg.text) > 0 ? parseFloat(msg.text) : null; state.step = 'awaiting_description_ge'; adminBot.sendMessage(chatId, 'შეიყვანეთ პროდუქტის აღწერა (ქართულად):', { reply_markup: { force_reply: true } }); break;
                case 'awaiting_description_ge': state.product.description_ge = msg.text; state.step = 'awaiting_description_en'; adminBot.sendMessage(chatId, 'შეიყვანეთ პროდუქტის აღწერა (ინგლისურად):', { reply_markup: { force_reply: true } }); break;
                case 'awaiting_description_en': state.product.description_en = msg.text; state.step = 'awaiting_category'; adminBot.sendMessage(chatId, 'შეიყვანეთ კატეგორია (მაგ: dresses, shirts):', { reply_markup: { force_reply: true } }); break;
                case 'awaiting_category': state.product.category = msg.text.toLowerCase(); state.step = 'awaiting_gender'; adminBot.sendMessage(chatId, 'მიუთითეთ სქესი (women ან men):', { reply_markup: { force_reply: true } }); break;
                case 'awaiting_gender': state.product.gender = msg.text.toLowerCase(); state.step = 'awaiting_sizes'; adminBot.sendMessage(chatId, 'შეიყვანეთ ზომები მძიმით გამოყოფით (მაგ: S,M,L):', { reply_markup: { force_reply: true } }); break;
                case 'awaiting_sizes': state.product.sizes = msg.text.split(',').map(s => s.trim().toUpperCase()); state.step = 'awaiting_images'; adminBot.sendMessage(chatId, "ატვირთეთ პროდუქტის ძირითადი ფოტო(ები). დასრულების შემდეგ, დაწერეთ 'done'."); break;
                case 'awaiting_images': if (msg.text.toLowerCase() === 'done') { if (!state.product.imageUrls || state.product.imageUrls.length === 0) return adminBot.sendMessage(chatId, "გთხოვთ, მინიმუმ ერთი ფოტო ატვირთოთ."); state.step = 'awaiting_qc_images'; adminBot.sendMessage(chatId, "ახლა ატვირთეთ 'ხარისხის შემოწმების' ფოტო(ები). დასრულების შემდეგ, დაწერეთ 'done'."); } break;
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
            adminBot.sendMessage(chatId, `დაფიქსირდა შეცდომა: ${e.message}\nსცადეთ თავიდან.`); 
            resetState(chatId); 
        }
    });

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
            if (uploadResponse.data.success) {
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
            } else { throw new Error(uploadResponse.data.error.message); }
        } catch (e) {
            console.error('Image upload failed:', e);
            adminBot.sendMessage(chatId, `ფოტოს ატვირთვა ვერ მოხერხდა: ${e.message}`);
        }
    });
}

// ===============================================
// --- Live Chat Endpoints ---
// ===============================================

app.post('/api/live-chat', (req, res) => {
    const { sessionId, isNewChat, userData, message } = req.body;
    if (!sessionId) {
        return res.status(400).json({ success: false, message: 'Session ID is required.' });
    }

    if (isNewChat) {
        chatSessions.set(sessionId, { userData, pendingMessages: [] });
        if (adminBot && TELEGRAM_GROUP_ID) {
            const notification = `
🔔 *ახალი ჩატი დაიწყო*
👤 *მომხმარებელი:* ${userData.name}
📧 *ელ.ფოსტა:* ${userData.email}
${userData.orderId ? `🔢 *შეკვეთის N:* ${userData.orderId}` : ''}
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
*${session.userData.name}:* ${message}
---
[Session ID: ${sessionId}]
            `;
            adminBot.sendMessage(TELEGRAM_GROUP_ID, userMessage, { parse_mode: 'Markdown' })
                .catch(err => console.error("Failed to forward user message to group:", err.message));
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
        res.json({ success: true, message });
    } else {
        res.json({ success: false, message: null });
    }
});

// ===============================================
// --- Other Utility Endpoints ---
// ===============================================

app.get('/api/orders', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM orders ORDER BY created_at DESC');
        res.json(result.rows);
    } catch (err) {
        console.error('API /api/orders error:', err);
        res.status(500).json({ success: false, message: 'Could not fetch orders' });
    }
});

app.post('/api/visitor', async (req, res) => {
    if (!adminBot || !TELEGRAM_CHANNEL_ID) {
        return res.status(200).json({ success: true, message: 'Visitor noted, but notifications are disabled.' });
    }
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
    } catch (e) { console.error(`Could not fetch geolocation for IP: ${ip}`, e.message); }
    try {
        await adminBot.sendMessage(TELEGRAM_CHANNEL_ID, message, { parse_mode: 'Markdown' });
        res.status(200).json({ success: true, message: 'Notification sent' });
    } catch (e) {
        console.error("Failed to send visitor notification to Telegram:", e.message);
        res.status(500).json({ success: false, message: 'Failed to send notification' });
    }
});

app.post('/api/cart/add', async (req, res) => {
    if (!adminBot || !TELEGRAM_CHANNEL_ID) {
        return res.status(200).json({ success: true, message: 'Cart action noted, but notifications are disabled.' });
    }

    const { product } = req.body; 

    if (!product || !product.name || !product.price) {
        return res.status(400).json({ success: false, message: 'Product data is missing or invalid.' });
    }

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
        console.error(`Could not fetch geolocation for IP: ${ip}`, e.message);
    }

    try {
        await adminBot.sendMessage(TELEGRAM_CHANNEL_ID, message, { parse_mode: 'Markdown' });
        res.status(200).json({ success: true, message: 'Cart notification sent' });
    } catch (e) {
        console.error("Failed to send cart notification to Telegram:", e.message);
        res.status(500).json({ success: false, message: 'Failed to send notification' });
    }
});

app.get('/api/order-status/:orderId', async (req, res) => {
    try {
        const { orderId } = req.params;
        const result = await pool.query('SELECT status FROM orders WHERE order_id = $1', [orderId]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Order not found' });
        }
        
        res.json({ success: true, status: result.rows[0].status });
    } catch (error) {
        console.error('Order status check failed:', error);
        res.status(500).json({ success: false, message: 'Failed to check order status' });
    }
});

// Admin dashboard endpoint
app.get('/api/admin/sales-data', async (req, res) => {
    try {
        const { months = 3 } = req.query;
        const dateThreshold = new Date();
        dateThreshold.setMonth(dateThreshold.getMonth() - parseInt(months));

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
    } catch (error) {
        console.error('Admin sales data error:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch sales data' });
    }
});

// ===============================================
// --- სერვერის გაშვება ---
// ===============================================
app.listen(port, async () => {
  console.log(`🚀 Server is running on port ${port}`);
  console.log(`💳 BOG Payment system integration: ${BOG_CLIENT_ID ? 'CONFIGURED' : 'MISSING CREDENTIALS'}`);
  
  await initializeDatabase();
  
  // ტესტი BOG კავშირის
  if (BOG_CLIENT_ID && BOG_CLIENT_SECRET) {
    await testBogConnection();
  } else {
    console.log('❌ BOG credentials missing - payment system will not work');
  }
  
  console.log(`🌐 Available endpoints:`);
  console.log(`   GET  /api/test-bog - BOG connection test`);
  console.log(`   GET  /api/health - Server health check`);
  console.log(`   GET  /api/products - Products list`);
  console.log(`   POST /api/submit-order - Submit order with BOG payment`);
  console.log(`   GET  /success - Payment success page`);
  console.log(`   GET  /fail - Payment failure page`);
});