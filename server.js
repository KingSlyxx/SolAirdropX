// server.js (სრული და გამართული ვერსია)

const express = require('express');
const bodyParser = require('body-parser');
const TelegramBot = require('node-telegram-bot-api');
const nodemailer = require('nodemailer');
const cors = require('cors');
const fs = require('fs'); // ფაილურ სისტემასთან სამუშაო მოდული
const path = require('path'); // ფაილის მისამართთან სამუშაო მოდული

const app = express();
const port = process.env.PORT || 3000;

// --- გარემოს ცვლადები (Environment Variables) ---
// დარწმუნდით, რომ ეს ცვლადები შეყვანილი გაქვთ Railway-ს პარამეტრებში
const ADMIN_BOT_TOKEN = process.env.ADMIN_BOT_TOKEN;
const LIVE_CHAT_BOT_TOKEN = process.env.LIVE_CHAT_BOT_TOKEN;
const NOTIFICATION_CHAT_ID = process.env.NOTIFICATION_CHAT_ID;
const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_PASS = process.env.GMAIL_PASS;

// --- Express-ის კონფიგურაცია ---
app.use(cors());
// ეს ხაზი ემსახურება სტატიკურ ფაილებს (მაგ: index.php, სურათები) "public" საქაღალდიდან.
// დარწმუნდით, რომ თქვენი საიტის ფაილები public საქაღალდეშია.
app.use(express.static('public')); 
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));


// --- სერვისების ინიციალიზაცია ---
// ეს კოდი იმუშავებს მხოლოდ მაშინ, თუ ტოკენები სწორად არის მითითებული Railway-ზე
let adminBot, liveChatBot;
if (ADMIN_BOT_TOKEN && NOTIFICATION_CHAT_ID) {
    adminBot = new TelegramBot(ADMIN_BOT_TOKEN, { polling: true });
}
if (LIVE_CHAT_BOT_TOKEN && NOTIFICATION_CHAT_ID) {
    liveChatBot = new TelegramBot(LIVE_CHAT_BOT_TOKEN, { polling: true });
}

const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: GMAIL_USER, pass: GMAIL_PASS }
});


// === API მარშრუტები (Routes) ===

// 1. პროდუქტების სიის მიღება products.json ფაილიდან (შესწორებული)
app.get('/api/products', (req, res) => {
    const productsFilePath = path.join(__dirname, 'products.json');

    fs.readFile(productsFilePath, 'utf8', (err, data) => {
        if (err) {
            console.error('Error reading products.json:', err);
            return res.status(500).json({ success: false, message: 'Could not fetch products' });
        }
        try {
            const products = JSON.parse(data);
            res.json(products);
        } catch (parseErr) {
            console.error('Error parsing products.json:', parseErr);
            return res.status(500).json({ success: false, message: 'Error parsing product data' });
        }
    });
});

// 2. შეკვეთის მიღება (უცვლელია)
app.post('/api/submit-order', async (req, res) => {
    if (!adminBot) {
        return res.status(500).json({ success: false, message: 'Admin Bot is not configured.' });
    }
    
    const orderData = req.body;
    const newOrderId = "LXRY" + Date.now().toString().slice(-6);
    
    try {
        // შეტყობინების გაგზავნა ადმინისტრატორთან
        const orderDetailsText = orderData.items.map(item => `- ${item.name.ge} (ზომა: ${item.size}) - ₾${item.price}`).join('\n');
        const customerInfoText = `
სახელი: ${orderData.customer.firstName} ${orderData.customer.lastName}
ტელეფონი: ${orderData.customer.phone}
მისამართი: ${orderData.customer.city}, ${orderData.customer.address}
ელ.ფოსტა: ${orderData.customer.email || 'არ არის მითითებული'}`;
        
        const notificationMessage = `🔔 **ახალი შეკვეთა!**\n\n**ID:** \`${newOrderId}\`\n\n**შეკვეთა:**\n${orderDetailsText}\n\n**სულ:** ₾${orderData.totalPrice}\n\n**მყიდველი:**\n${customerInfoText}`;
        
        adminBot.sendMessage(NOTIFICATION_CHAT_ID, notificationMessage, { parse_mode: 'Markdown' });

        // იმეილის გაგზავნა კლიენტთან (თუ იმეილი მითითებულია)
        if (orderData.customer.email && GMAIL_USER) {
            const mailOptions = {
                from: GMAIL_USER,
                to: orderData.customer.email,
                subject: `შეკვეთა #${newOrderId} მიღებულია`,
                html: `<p>მადლობა შეკვეთისთვის! თქვენი შეკვეთის ნომერია: <strong>${newOrderId}</strong></p>`
            };
            transporter.sendMail(mailOptions);
        }

        res.status(200).json({ success: true, orderId: newOrderId });

    } catch (err) {
        console.error('Error submitting order:', err);
        res.status(500).json({ success: false, message: 'Could not process order' });
    }
});

// 3. ლაივ ჩატის შეტყობინება (უცვლელია)
app.post('/api/live-chat', (req, res) => {
    if (!liveChatBot) {
        return res.status(500).json({ success: false, message: 'Live Chat Bot is not configured.' });
    }

    const { message } = req.body;
    const notification = `💬 **ლაივ ჩატი:**\n\n${message}`;
    liveChatBot.sendMessage(NOTIFICATION_CHAT_ID, notification, { parse_mode: 'Markdown' });
    res.status(200).json({success: true});
});


// 4. შეკვეთის სტატუსის მიღება (დროებითი ლოგიკა)
app.get('/api/order-status/:orderId', async (req, res) => {
    const { orderId } = req.params;
    // ეს დროებითი ლოგიკაა, რადგან შეკვეთები არ ინახება ბაზაში.
    // მომავალში აქ ბაზიდან უნდა წამოიღოთ ინფორმაცია.
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
