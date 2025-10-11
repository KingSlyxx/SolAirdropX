// server.js (სრული კოდი შეკვეთის შექმნის და BOG ინტეგრაციით)

const express = require('express');
const bodyParser = require('body-parser');
const TelegramBot = require('node-telegram-bot-api');
const cors = require('cors');
const axios = require('axios');
const { Pool } = require('pg');
const { URLSearchParams } = require('url'); 
const moment = require('moment'); // საჭიროა სტატისტიკისთვის

const app = express();
const port = process.env.PORT || 8080;

// ===============================================
// --- გარემოს ცვლადები და კონფიგურაცია --
// ===============================================

// BOG-ის კონფიგურაცია - აუცილებელია სწორად იყოს დაყენებული თქვენს გარემოს ცვლადებში
const BOG_CLIENT_ID = process.env.BOG_CLIENT_ID; 
const BOG_CLIENT_SECRET = process.env.BOG_CLIENT_SECRET;
const BOG_BASE_URL = process.env.BOG_BASE_URL || 'https://api.bog.ge'; // ან სატესტო URL
const CLIENT_BASE_URL = process.env.CLIENT_BASE_URL || 'https://lxryto.ge'; // თქვენი საიტის URL
const API_BASE_URL = process.env.API_BASE_URL || 'https://api.lxryto.ge';   // თქვენი API-ს URL

// Telegram-ის კონფიგურაცია
const ADMIN_BOT_TOKEN = process.env.ADMIN_BOT_TOKEN;
const TELEGRAM_GROUP_ID = process.env.TELEGRAM_GROUP_ID || '-4644402426'; // თქვენი ჯგუფის ID

// DB კონფიგურაცია
const DATABASE_URL = process.env.DATABASE_URL;
const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// Telegram ბოტის ინიციალიზაცია
const bot = new TelegramBot(ADMIN_BOT_TOKEN, { polling: false });

// ===============================================
// --- Middlewares --
// ===============================================
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// ===============================================
// --- დამხმარე ფუნქციები --
// ===============================================

/**
 * აგზავნის შეტყობინებას Telegram-ში ახალი შეკვეთის შესახებ.
 * @param {object} order - შეკვეთის ობიექტი DB-დან
 */
const sendTelegramNotification = async (order) => {
    if (!ADMIN_BOT_TOKEN || !TELEGRAM_GROUP_ID) {
        console.error('Telegram bot credentials are not set.');
        return;
    }

    // შეკვეთის დეტალების ფორმატირება
    const customer = order.customer_data || {};
    const itemsList = (order.items || []).map(item => 
        `• ${item.name} (${item.color}, ${item.size}) x${item.quantity}`
    ).join('\n');
    
    const message = `
🔔 *ახალი შეკვეთა მიღებულია!* 🔔
==============================
*შეკვეთის ID:* \`${order.order_id}\`
*სტატუსი:* *PAID* ✅ (გადახდილია)
*ჯამი:* *${order.total_price.toFixed(2)} GEL*

*მომხმარებლის დეტალები:*
სახელი: ${customer.name || 'N/A'}
ტელეფონი: \`${customer.phone || 'N/A'}\`
მისამართი: ${customer.address || 'N/A'}

*შეკვეთილი ნივთები:*
${itemsList}
==============================
`;

    try {
        await bot.sendMessage(TELEGRAM_GROUP_ID, message, {
            parse_mode: 'Markdown'
        });
        console.log(`Telegram notification sent for Order ID: ${order.order_id}`);
    } catch (error) {
        console.error('Error sending Telegram notification:', error.message);
    }
};

/**
 * იღებს BOG Access Token-ს.
 */
const getBogAccessToken = async () => {
    if (!BOG_CLIENT_ID || !BOG_CLIENT_SECRET) {
        throw new Error('BOG_CLIENT_ID or BOG_CLIENT_SECRET is missing.');
    }
    try {
        const authString = Buffer.from(`${BOG_CLIENT_ID}:${BOG_CLIENT_SECRET}`).toString('base64');
        const tokenResponse = await axios.post(
            BOG_BASE_URL + '/oauth/token',
            new URLSearchParams({ grant_type: 'client_credentials' }).toString(),
            {
                headers: {
                    'Authorization': `Basic ${authString}`,
                    'Content-Type': 'application/x-www-form-urlencoded'
                }
            }
        );
        return tokenResponse.data.access_token;
    } catch (error) {
        console.error('Error fetching BOG Access Token:', error.response ? error.response.data : error.message);
        throw new Error('Failed to get BOG Access Token');
    }
};

// ===============================================
// --- API როუტები: შეკვეთის შექმნა ---
// ===============================================

/**
 * POST /api/order/create
 * მიიღებს შეკვეთის მონაცემებს, ჩაწერს ბაზაში (pending სტატუსით) და ინიციალიზაციას გაუკეთებს BOG გადახდას.
 */
app.post('/api/order/create', async (req, res) => {
    // ველოდებით მონაცემებს, როგორიცაა: items, total_price, customer_data, payment_method
    const { items, total_price, customer_data, payment_method } = req.body;
    
    if (!items || !total_price || !customer_data) {
        return res.status(400).json({ success: false, message: 'Missing required order data.' });
    }

    let orderId;
    try {
        // --- 1. შეკვეთის ჩაწერა ბაზაში (საწყისი სტატუსით 'pending') ---
        const insertQuery = `
            INSERT INTO orders (customer_data, items, total_price, status) 
            VALUES ($1, $2, $3, $4) RETURNING order_id;
        `;
        const priceToInsert = parseFloat(total_price); 

        const result = await pool.query(insertQuery, [
            JSON.stringify(customer_data), 
            JSON.stringify(items),        
            priceToInsert, 
            'pending' // საწყისი სტატუსი
        ]);
        orderId = result.rows[0].order_id;
        console.log(`Order ${orderId} successfully inserted into DB with status 'pending'.`);

        // --- 2. BOG გადახდის ინიციალიზაცია ---
        if (payment_method === 'bog') {
            const accessToken = await getBogAccessToken();
            
            const bogPayload = {
                amount: priceToInsert,
                currency: 'GEL',
                extPaymentId: orderId.toString(), // ეს არის ჩვენი order_id
                successUrl: `${CLIENT_BASE_URL}/order-success?order_id=${orderId}`, // კლიენტის წარმატების გვერდი
                failUrl: `${CLIENT_BASE_URL}/order-failed?order_id=${orderId}`,   // კლიენტის წარუმატებლობის გვერდი
                callbackUrl: `${API_BASE_URL}/api/bog/callback`, // სერვერის უკუკავშირის როუტი
                locale: 'ka',
                description: `Order #${orderId} from LXRYTO`,
                preAuth: false
            };

            const bogResponse = await axios.post(
                BOG_BASE_URL + '/api/v1/payment/purchase',
                bogPayload,
                {
                    headers: {
                        'Authorization': `Bearer ${accessToken}`,
                        'Content-Type': 'application/json'
                    }
                }
            );
            
            // BOG-ის გადახდის გვერდის ლინკის მიღება
            const paymentUrl = bogResponse.data.links.find(link => link.rel === 'forms')?.uri;
            if (!paymentUrl) {
                throw new Error('BOG did not return payment form URL.');
            }

            return res.json({ 
                success: true, 
                message: 'Payment initialized',
                orderId: orderId,
                paymentUrl: paymentUrl // ამ ლინკს იღებს ფრონტენდი და გადამისამართდება
            });
        }
        
        // --- 3. თუ არ არის BOG (მაგ. ნაღდი ანგარიშსწორება) ---
        return res.json({ success: true, message: 'Order created successfully (Pending)', orderId: orderId });

    } catch (error) {
        console.error(`CRITICAL ORDER INSERTION OR BOG ERROR for Order ID ${orderId}:`, error.message);
        if (error.response) {
            console.error('BOG API Error Details:', error.response.data); 
        }

        // თუ ბაზაში ჩაწერა მოხდა, მაგრამ BOG-ის ინიციალიზაცია ჩავარდა, ვშლით შეკვეთას
        if (orderId) {
            console.log(`Cleaning up failed order ${orderId} from DB.`);
            await pool.query('DELETE FROM orders WHERE order_id = $1', [orderId]);
        }

        res.status(500).json({ success: false, message: 'Order submission failed. Please try again later.' });
    }
});


// ===============================================
// --- API როუტები: BOG Callback (უკუკავშირი) ---
// ===============================================

/**
 * POST /api/bog/callback
 * ამ როუტს იძახებს BOG სერვერი გადახდის სტატუსის განახლებისთვის.
 */
app.post('/api/bog/callback', async (req, res) => {
    const { extPaymentId, paymentStatus } = req.body; 

    if (!extPaymentId || !paymentStatus) {
        console.error('BOG Callback: Missing extPaymentId or paymentStatus');
        return res.status(400).end(); 
    }

    try {
        const newStatus = paymentStatus === 'SUCCESS' ? 'paid' : 'failed';

        // ბაზაში შეკვეთის სტატუსის განახლება
        await pool.query('UPDATE orders SET status = $1 WHERE order_id = $2', [newStatus, extPaymentId]);
        console.log(`Order ${extPaymentId} status updated to ${newStatus}.`);

        if (newStatus === 'paid') {
            const orderResult = await pool.query('SELECT * FROM orders WHERE order_id = $1', [extPaymentId]);
            if (orderResult.rows.length > 0) {
                const order = orderResult.rows[0];
                await sendTelegramNotification(order); // Telegram შეტყობინების გაგზავნა
            }
        }

        res.status(200).end(); // აუცილებელია BOG-ის სერვერისთვის

    } catch (error) {
        console.error(`BOG Callback processing error for Order ID ${extPaymentId}:`, error);
        res.status(500).end();
    }
});


// ===============================================
// --- API როუტები: ადმინისტრატორის სტატისტიკა ---
// ===============================================

/**
 * GET /api/admin/sales-data
 * აბრუნებს სტატისტიკას (შემოსავალი, გაყიდვები) განსაზღვრული პერიოდისთვის.
 */
app.get('/api/admin/sales-data', async (req, res) => {
    const { months = 1 } = req.query; // ნაგულისხმევად ბოლო 1 თვე
    
    try {
        const dateThreshold = moment().subtract(parseInt(months), 'months').toDate();
        
        const revenueResult = await pool.query(
            'SELECT SUM(total_price) as total_revenue FROM orders WHERE created_at >= $1 AND status = $2',
            [dateThreshold, 'paid']
        );
        
        const salesResult = await pool.query(
            'SELECT COUNT(*) as total_sales FROM orders WHERE created_at >= $1 AND status = $2',
            [dateThreshold, 'paid']
        );
        
        const recentSalesResult = await pool.query(
            `SELECT order_id, customer_data, items, total_price, created_at, status 
             FROM orders 
             WHERE created_at >= $1 
             ORDER BY created_at DESC 
             LIMIT 10`,
            [dateThreshold]
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
// --- სერვერის გაშვება --
// ===============================================

// DB კავშირის შემოწმება
pool.connect()
    .then(client => {
        console.log('Successfully connected to PostgreSQL database.');
        client.release();
    })
    .catch(err => {
        console.error('ERROR connecting to PostgreSQL database:', err.message);
        // სერვერის გაშვება შეცდომის მიუხედავად (თუ DB მოგვიანებით ჩაირთვება)
    });

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
  console.log(`BOG Payment system initialized.`);
});
