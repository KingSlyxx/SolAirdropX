// server.js (გაუმჯობესებული ვერსია)

const express = require('express');
const bodyParser = require('body-parser');
const TelegramBot = require('node-telegram-bot-api');
const nodemailer = require('nodemailer');
const cors = require('cors');

// --- 1. მონაცემთა ბაზასთან დასაკავშირებელი კლიენტის დამატება (მაგალითად, pg PostgreSQL-ისთვის)
// const { Pool } = require('pg');

const app = express();
const port = process.env.PORT || 3000;

// --- გარემოს ცვლადები (ეს ნაწილი იდეალურია) ---
const ADMIN_BOT_TOKEN = process.env.ADMIN_BOT_TOKEN;
const LIVE_CHAT_BOT_TOKEN = process.env.LIVE_CHAT_BOT_TOKEN;
const NOTIFICATION_CHAT_ID = process.env.NOTIFICATION_CHAT_ID;
const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_PASS = process.env.GMAIL_PASS;
// const DATABASE_URL = process.env.DATABASE_URL; // Railway-ზე ბაზის დამატებისას ეს ცვლადი ავტომატურად შეიქმნება

// --- 2. მონაცემთა ბაზასთან კავშირის დამყარება ---
// const pool = new Pool({
//   connectionString: DATABASE_URL,
//   ssl: {
//     rejectUnauthorized: false
//   }
// });

// ბოტების ინიციალიზაცია (უცვლელია)
const adminBot = new TelegramBot(ADMIN_BOT_TOKEN, { polling: true });
const liveChatBot = new TelegramBot(LIVE_CHAT_BOT_TOKEN, { polling: true });

// იმეილის კონფიგურაცია (უცვლელია)
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: GMAIL_USER, pass: GMAIL_PASS }
});

// Express-ის კონფიგურაცია
app.use(cors());
app.use(express.static('public')); 
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));


// === API მარშრუტები (Routes) - განახლებული ბაზასთან სამუშაოდ ===

// 1. პროდუქტების სიის მიღება ბაზიდან
app.get('/api/products', async (req, res) => {
    try {
        // const result = await pool.query('SELECT * FROM products ORDER BY id ASC');
        // res.json(result.rows);
        
        // --- სანამ ბაზას დაამატებთ, შეგიძლიათ გამოიყენოთ ძველი ვერსია ---
        res.json([
            { id: 7, name: {ge: 'ჯინსის შარვალი', en: 'Denim Jeans'}, price: '189.99' /* ... დანარჩენი მონაცემები ... */ }
        ]);

    } catch (err) {
        console.error('Error fetching products:', err);
        res.status(500).json({ success: false, message: 'Could not fetch products' });
    }
});

// 2. შეკვეთის მიღება და ბაზაში შენახვა
app.post('/api/submit-order', async (req, res) => {
    const orderData = req.body;
    const newOrderId = "LXRY" + Date.now().toString().slice(-6);
    
    try {
        // --- 3. აქ შეკვეთა უნდა შეინახოს მონაცემთა ბაზაში ---
        // await pool.query(
        //   'INSERT INTO orders (order_id, customer_info, items, total_price, status) VALUES ($1, $2, $3, $4, $5)',
        //   [newOrderId, orderData.customer, JSON.stringify(orderData.items), orderData.totalPrice, 'Processing']
        // );

        console.log(`New Order ${newOrderId} saved to database.`);

        // შეტყობინებების ლოგიკა უცვლელია
        const orderDetailsText = orderData.items.map(item => `პროდუქტი: ${item.name.ge}\nზომა: ${item.size}\nფასი: ₾${item.price}`).join('\n\n');
        const notificationMessage = `🔔 **ახალი შეკვეთა!**\n\n**ID:** \`${newOrderId}\`\n...`; // შეტყობინების სრული ტექსტი
        adminBot.sendMessage(NOTIFICATION_CHAT_ID, notificationMessage, { parse_mode: 'Markdown' });

        // იმეილის გაგზავნა
        if (orderData.customer.email) {
            // იმეილის ლოგიკა უცვლელია...
        }

        res.status(200).json({ success: true, orderId: newOrderId });

    } catch (err) {
        console.error('Error submitting order:', err);
        res.status(500).json({ success: false, message: 'Could not process order' });
    }
});

// 3. ლაივ ჩატის შეტყობინება (უცვლელია)
app.post('/api/live-chat', (req, res) => {
    const { message } = req.body;
    const notification = `💬 **ახალი შეტყობინება ლაივ ჩატში:**\n\n${message}`;
    liveChatBot.sendMessage(NOTIFICATION_CHAT_ID, notification, { parse_mode: 'Markdown' });
    res.status(200).json({success: true});
});


// 4. შეკვეთის სტატუსის მიღება ბაზიდან
app.get('/api/order-status/:orderId', async (req, res) => {
    const { orderId } = req.params;
    try {
        // const result = await pool.query('SELECT status FROM orders WHERE order_id = $1', [orderId]);
        // if (result.rows.length > 0) {
        //     res.json({ success: true, status: result.rows[0].status });
        // } else {
        //     res.status(404).json({ success: false, status: "შეკვეთის ID ვერ მოიძებნა." });
        // }

        // --- დროებითი ლოგიკა ---
        const dummyStatus = { "LXRY123456": "მუშავდება" };
        if (dummyStatus[orderId]) {
            res.json({ success: true, status: dummyStatus[orderId] });
        } else {
            res.status(404).json({ success: false, status: "შეკვეთის ID ვერ მოიძებნა." });
        }

    } catch (err) {
        console.error('Error fetching order status:', err);
        res.status(500).json({ success: false, message: 'Could not fetch order status' });
    }
});


// სერვერის გაშვება
app.listen(port, () => {
    console.log(`Server is running on http://localhost:${port}`);
});
