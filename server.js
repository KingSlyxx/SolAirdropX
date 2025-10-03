// server.js (საბოლოო, დადასტურებულად მუშა ვერსია)

const express = require('express');
const bodyParser = require('body-parser');
const TelegramBot = require('node-telegram-bot-api');
const nodemailer = require('nodemailer');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();

// Railway-სთვის პორტის დინამიკური მინიჭება
const port = process.env.PORT || 3000;

// --- გარემოს ცვლადები (Environment Variables) ---
const ADMIN_BOT_TOKEN = process.env.ADMIN_BOT_TOKEN;
const LIVE_CHAT_BOT_TOKEN = process.env.LIVE_CHAT_BOT_TOKEN;
const NOTIFICATION_CHAT_ID = process.env.NOTIFICATION_CHAT_ID;
const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_PASS = process.env.GMAIL_PASS;

// --- Express-ის კონფიგურაცია ---
app.use(cors());
app.use(express.static('public')); 
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// --- სერვისების ინიციალიზაცია ---
let adminBot, liveChatBot;

if (ADMIN_BOT_TOKEN) {
    adminBot = new TelegramBot(ADMIN_BOT_TOKEN);
}
if (LIVE_CHAT_BOT_TOKEN) {
    liveChatBot = new TelegramBot(LIVE_CHAT_BOT_TOKEN);
}

let transporter;
if (GMAIL_USER && GMAIL_PASS) {
    transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: { user: GMAIL_USER, pass: GMAIL_PASS }
    });
}

// === API მარშრუტები (Routes) ===

// 1. პროდუქტების სიის მიღება products.json ფაილიდან
app.get('/api/products', (req, res) => {
    const productsFilePath = path.join(__dirname, 'products.json');
    fs.readFile(productsFilePath, 'utf8', (err, data) => {
        if (err) {
            console.error('Error reading products.json:', err);
            return res.status(500).json({ success: false, message: 'Could not fetch products' });
        }
        try {
            res.json(JSON.parse(data));
        } catch (parseErr) {
            console.error('Error parsing products.json:', parseErr);
            return res.status(500).json({ success: false, message: 'Error parsing product data' });
        }
    });
});

// 2. შეკვეთის მიღება
app.post('/api/submit-order', async (req, res) => {
    if (!adminBot || !NOTIFICATION_CHAT_ID) {
        console.error('Admin Bot or Notification Chat ID is not configured.');
        return res.status(500).json({ success: false, message: 'Bot is not configured on the server.' });
    }
    
    const { customer, items, totalPrice } = req.body;
    const newOrderId = "LXRY" + Date.now().toString().slice(-6);
    
    try {
        const orderDetailsText = items.map(item => `- ${item.name.ge} (ზომა: ${item.size}) - ₾${item.price}`).join('\n');
        const customerInfoText = `
სახელი: ${customer.firstName} ${customer.lastName}
ტელეფონი: ${customer.phone}
მისამართი: ${customer.city}, ${customer.address}
ელ.ფოსტა: ${customer.email || 'არ არის მითითებული'}`;
        
        const notificationMessage = `🔔 **ახალი შეკვეთა!**\n\n**ID:** \`${newOrderId}\`\n\n**შეკვეთა:**\n${orderDetailsText}\n\n**სულ:** ₾${totalPrice}\n\n**მყიდველი:**\n${customerInfoText}`;
        
        await adminBot.sendMessage(NOTIFICATION_CHAT_ID, notificationMessage, { parse_mode: 'Markdown' });

        if (customer.email && transporter) {
            await transporter.sendMail({
                from: GMAIL_USER,
                to: customer.email,
                subject: `შეკვეთა #${newOrderId} მიღებულია`,
                html: `<p>მადლობა შეკვეთისთვის! თქვენი შეკვეთის ნომერია: <strong>${newOrderId}</strong></p>`
            });
        }
        res.status(200).json({ success: true, orderId: newOrderId });
    } catch (err) {
        console.error('Error submitting order:', err.response ? err.response.body : err.message);
        res.status(500).json({ success: false, message: 'Could not process order' });
    }
});

// 3. ლაივ ჩატის შეტყობინება
app.post('/api/live-chat', async (req, res) => {
    if (!liveChatBot || !NOTIFICATION_CHAT_ID) {
        console.error('Live Chat Bot or Notification Chat ID is not configured.');
        return res.status(500).json({ success: false, message: 'Chat Bot is not configured on the server.' });
    }
    
    const { message } = req.body;
    const notification = `💬 **ლაივ ჩატი:**\n\n${message}`;
    
    try {
        await liveChatBot.sendMessage(NOTIFICATION_CHAT_ID, notification, { parse_mode: 'Markdown' });
        res.status(200).json({success: true});
    } catch (err) {
        console.error('Error sending live chat message:', err.response ? err.response.body : err.message);
        res.status(500).json({ success: false, message: 'Could not send message' });
    }
});

// 4. შეკვეთის სტატუსის მიღება (დროებითი ლოგიკა)
app.get('/api/order-status/:orderId', (req, res) => {
    const { orderId } = req.params;
    const dummyStatus = { "LXRY123456": "მუშავდება" };
    if (dummyStatus[orderId]) {
        res.json({ success: true, status: dummyStatus[orderId] });
    } else {
        res.status(404).json({ success: false, status: "შეკვეთის ID ვერ მოიძებნა." });
    }
});

// --- სერვერის გაშვება ---
app.listen(port, () => {
  console.log(`Server is running on port ${port}`); 
});
