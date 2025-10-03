// server.js

const express = require('express');
const bodyParser = require('body-parser');
const TelegramBot = require('node-telegram-bot-api');
const nodemailer = require('nodemailer');
const cors = require('cors'); // <-- 1. CORS-ის დამატება

const app = express();
const port = process.env.PORT || 3000;

// --- მნიშვნელოვანი: ეს მონაცემები უნდა შეავსოთ ჰოსტინგ პლატფორმის Environment Variables-ში ---
// --- ახალი, გასწორებული კოდი ---
const ADMIN_BOT_TOKEN = process.env.ADMIN_BOT_TOKEN;
const LIVE_CHAT_BOT_TOKEN = process.env.LIVE_CHAT_BOT_TOKEN;
const NOTIFICATION_CHAT_ID = process.env.NOTIFICATION_CHAT_ID;
const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_PASS = process.env.GMAIL_PASS;
// --- დასასრული ---

// ბოტების ინიციალიზაცია
const adminBot = new TelegramBot(ADMIN_BOT_TOKEN, { polling: true });
const liveChatBot = new TelegramBot(LIVE_CHAT_BOT_TOKEN, { polling: true });

// იმეილის გაგზავნის კონფიგურაცია
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: GMAIL_USER,
        pass: GMAIL_PASS
    }
});

// Express-ის კონფიგურაცია
app.use(cors()); // <-- 2. CORS-ის გამოყენება
app.use(express.static('public')); 
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));


// --- მონაცემთა ბაზის სიმულაცია ---
let products = [
    { /* ... არსებული პროდუქტი 1 ... */ },
    { /* ... არსებული პროდუქტი 2 ... */ },

    // --- ახალი პროდუქტის მაგალითი ---
    { 
      id: 7, // მიუთითეთ ახალი, უნიკალური ID
      name: {ge: 'ჯინსის შარვალი', en: 'Denim Jeans'}, 
      price: '189.99', 
      oldPrice: '220.00', 
      category: 'pants', // კატეგორია
      gender: 'men', // 'men' ან 'women'
      imageUrls: ['https://your-image-url.com/image1.jpg', 'https://your-image-url.com/image2.jpg'], // თქვენი სურათების ლინკები
      sizes: ['S', 'M', 'L', 'XL'], 
      description: {ge: 'კლასიკური სტილის ჯინსის შარვალი ყოველდღიური სტილისთვის.', en: 'Classic style denim jeans for everyday wear.'} 
    }
];


let dummyOrders = {
    "12345": "თქვენი შეკვეთა მუშავდება.",
};
// --- დასასრული ---


// === API მარშრუტები (Routes) ===

// 1. პროდუქტების სიის მიღება
app.get('/api/products', (req, res) => {
    res.json(products);
});

// 2. შეკვეთის მიღება
app.post('/api/submit-order', (req, res) => {
    const orderData = req.body;
    
    const newOrderId = "LXRY" + Date.now().toString().slice(-6);
    orderData.orderId = newOrderId;
    console.log(`New Order Received with ID: ${newOrderId}`, orderData);

    dummyOrders[newOrderId] = "შეკვეთა მიღებულია, მუშავდება. მიწოდების სავარაუდო დრო: 14-21 დღე.";

    const orderDetailsText = orderData.items.map(item => 
        `პროდუქტი: ${item.name.ge}\nზომა: ${item.size}\nფასი: ₾${item.price}`
    ).join('\n\n');

    const notificationMessage = `
🔔 **ახალი შეკვეთა!**

**შეკვეთის ID:** \`${newOrderId}\`

**მყიდველის ინფორმაცია:**
- სახელი: ${orderData.customer.firstName} ${orderData.customer.lastName}
- ქალაქი: ${orderData.customer.city}
- მისამართი: ${orderData.customer.address}
- ტელეფონი: \`${orderData.customer.phone}\`
- იმეილი: ${orderData.customer.email}

**შეკვეთა:**
${orderDetailsText}

**სულ გადასახდელი: ₾${orderData.totalPrice}**
    `;

    adminBot.sendMessage(NOTIFICATION_CHAT_ID, notificationMessage, { parse_mode: 'Markdown' });

    if (orderData.customer.email && GMAIL_USER !== 'your-email@gmail.com') {
        const emailHtml = `
            <h3>გამარჯობა, ${orderData.customer.firstName}!</h3>
            <p>თქვენი შეკვეთა (ID: ${newOrderId}) მიღებულია და მალე დამუშავდება. ჩვენი ოპერატორი დაგიკავშირდებათ დეტალების დასაზუსტებლად.</p>
            <h4>შეკვეთის დეტალები:</h4>
            <ul>
                ${orderData.items.map(item => `<li>${item.name.ge} (ზომა: ${item.size}) - ₾${item.price}</li>`).join('')}
            </ul>
            <p><strong>სულ: ₾${orderData.totalPrice}</strong></p>
            <p>გმადლობთ, რომ სარგებლობთ ჩვენი სერვისით!</p>
        `;
        
        transporter.sendMail({
            from: `"LXRYTOO" <${GMAIL_USER}>`,
            to: orderData.customer.email,
            subject: `შეკვეთა #${newOrderId} მიღებულია`,
            html: emailHtml
        }).catch(err => console.error("Could not send email:", err));
    }


    res.status(200).json({ success: true, orderId: newOrderId });
});

// 3. ლაივ ჩატის შეტყობინების მიღება საიტიდან
app.post('/api/live-chat', (req, res) => {
    const { message } = req.body;
    const notification = `💬 **ახალი შეტყობინება ლაივ ჩატში:**\n\n${message}`;
    liveChatBot.sendMessage(NOTIFICATION_CHAT_ID, notification, { parse_mode: 'Markdown' });
    res.status(200).json({success: true});
});

// 4. შეკვეთის სტატუსის მისაღები მარშრუტი
app.get('/api/order-status/:orderId', (req, res) => {
    const { orderId } = req.params;
    const status = dummyOrders[orderId];

    if (status) {
        res.json({ success: true, status: status });
    } else {
        res.status(404).json({ success: false, status: "შეკვეთის ID ვერ მოიძებნა." });
    }
});

// === ტელეგრამის ბოტების ლოგიკა ===

// (თქვენი ტელეგრამის ლოგიკა უცვლელი რჩება)
// ... (სრული კოდი server.js-დან)

// სერვერის გაშვება
app.listen(port, () => {
    console.log(`Server is running on http://localhost:${port}`);
});