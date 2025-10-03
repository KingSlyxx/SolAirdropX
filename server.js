// server.js

const express = require('express');
const bodyParser = require('body-parser');
const TelegramBot = require('node-telegram-bot-api');
const nodemailer = require('nodemailer');

const app = express();
const port = process.env.PORT || 3000;

// --- მნიშვნელოვანი: ეს მონაცემები უნდა შეავსოთ ჰოსტინგ პლატფორმის Environment Variables-ში ---
const ADMIN_BOT_TOKEN = process.env.ADMIN_BOT_TOKEN || '8151755873:AAE5ApDfeDT0akuPw9SeZ2ATwdXhDobJPV4';
const LIVE_CHAT_BOT_TOKEN = process.env.LIVE_CHAT_BOT_TOKEN || '7941086584:AAHGI5dBdR4Gy63Vuih9jJpQ9GRfsCSzTzQ';
const NOTIFICATION_CHAT_ID = process.env.NOTIFICATION_CHAT_ID || '-4644402426';
const GMAIL_USER = process.env.GMAIL_USER || 'your-email@gmail.com';
const GMAIL_PASS = process.env.GMAIL_PASS || 'your-gmail-app-password';
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
app.use(express.static('public')); // ვემსახურებით ფაილებს `public` ფოლდერიდან
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));


// --- მონაცემთა ბაზის სიმულაცია ---
// !!! ყურადღება: ეს მონაცემები სერვერის ყოველ გადატვირთვაზე იშლება.
// რეალური პროექტისთვის დაგჭირდებათ მონაცემთა ბაზა (მაგ. MongoDB ან PostgreSQL)
let products = [
    { id: 1, name: {ge: 'საზაფხულო კაბა', en: 'Summer Dress'}, price: '129.99', oldPrice: '159.99', category: 'dresses', gender: 'women', 
      imageUrls: ['https://i.ibb.co/6y18B9M/image-1.png', 'https://i.ibb.co/hZ2vWJm/image-2.png', 'https://i.ibb.co/C0bN0Gk/image-3.png'],
      sizes: ['XS', 'S', 'M', 'L', 'XL', 'XXL'], description: {ge: 'მსუბუქი და ჰაეროვანი საზაფხულო კაბა, იდეალური ცხელი დღეებისთვის.', en: 'A light and airy summer dress, perfect for hot days.'} },
    { id: 6, name: {ge: 'კლასიკური პერანგი', en: 'Classic Shirt'}, price: '110.00', oldPrice: '140.00', category: 'shirts', gender: 'men',
      imageUrls: ['https://i.ibb.co/Q8Qf1dY/pexels-dmitry-zvolskiy-2064505.jpg', 'https://i.ibb.co/yWz33J3/pexels-justin-shaifer-1222271.jpg'],
      sizes: ['XS', 'S', 'M', 'L', 'XL', 'XXL'], description: {ge: 'დახვეწილი და კლასიკური პერანგი თანამედროვე მამაკაცისთვის.', en: 'A sophisticated and classic shirt for the modern man.'} }
];

const dummyOrders = {
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
    
    const newOrderId = Date.now().toString(36) + Math.random().toString(36).substring(2, 7);
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


    res.status(200).json({ message: 'Order received successfully' });
});

// 3. ლაივ ჩატის შეტყობინების მიღება საიტიდან
app.post('/api/live-chat', (req, res) => {
    const { message } = req.body;
    const notification = `💬 **ახალი შეტყობინება ლაივ ჩატში:**\n\n${message}`;
    liveChatBot.sendMessage(NOTIFICATION_CHAT_ID, notification, { parse_mode: 'Markdown' });
    res.status(200).send();
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

// ლაივ ჩატის ბოტი (ადმინის პასუხი მომხმარებელს)
liveChatBot.on('message', (msg) => {
    console.log(`Live Chat Bot Received: "${msg.text}" from admin.`);
    liveChatBot.sendMessage(msg.chat.id, "პასუხის გაგზავნა საიტზე მოითხოვს WebSocket-ის ინტეგრაციას, რაც ამ ეტაპზე დამატებული არ არის.");
});

// ადმინ ბოტის ლოგიკა (პროდუქტის მართვა)
const userStates = {};

adminBot.onText(/\/start/, (msg) => {
    adminBot.sendMessage(msg.chat.id, "მოგესალმებით! სტატუსის განაახლებლად გამოიყენეთ ბრძანება:\n`/status [ID] [ახალი სტატუსი]`", {
        parse_mode: 'Markdown',
        reply_markup: {
            keyboard: [
                [{ text: "📦 პროდუქტის დამატება" }],
                [{ text: "📝 პროდუქტების ნახვა" }, { text: "❌ პროდუქტის წაშლა" }]
            ],
            resize_keyboard: true
        }
    });
});

// სტატუსის განახლების ბრძანება
adminBot.onText(/\/status (.+)/, (msg, match) => {
    const chatId = msg.chat.id;
    const parts = match[1].split(' ');
    const orderId = parts.shift();
    const newStatus = parts.join(' ');

    if (!orderId || !newStatus) {
        adminBot.sendMessage(chatId, "არასწორი ფორმატი. გამოიყენეთ: `/status [ID] [ტექსტი]`");
        return;
    }

    if (dummyOrders[orderId]) {
        dummyOrders[orderId] = newStatus;
        adminBot.sendMessage(chatId, `✅ სტატუსი განახლდა ID-სთვის: \`${orderId}\``, { parse_mode: 'Markdown' });
    } else {
        adminBot.sendMessage(chatId, `❌ შეკვეთის ID \`${orderId}\` ვერ მოიძებნა.`, { parse_mode: 'Markdown' });
    }
});

// პროდუქტის მართვის ლოგიკა
adminBot.on('message', (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;

    if (text.startsWith('/')) return; // იგნორირება, თუ ბრძანებაა

    if (text === "📦 პროდუქტის დამატება") {
        userStates[chatId] = { step: "awaiting_name" };
        adminBot.sendMessage(chatId, "შეიყვანეთ პროდუქტის სათაური (მაგ: საზაფხულო კაბა):");
        return;
    }
     if (text === "📝 პროდუქტების ნახვა") {
        let productList = "არსებული პროდუქტები:\n\n";
        products.forEach(p => {
            productList += `ID: ${p.id}\nსათაური: ${p.name.ge}\nფასი: ₾${p.price}\n\n`;
        });
        adminBot.sendMessage(chatId, productList);
        return;
    }
    if (text === "❌ პროდუქტის წაშლა") {
        userStates[chatId] = { step: "awaiting_delete_id" };
        adminBot.sendMessage(chatId, "შეიყვანეთ პროდუქტის ID, რომლის წაშლაც გსურთ:");
        return;
    }

    if (userStates[chatId]) {
        const state = userStates[chatId];
        switch (state.step) {
            case "awaiting_name":
                state.name = text;
                state.step = "awaiting_price";
                adminBot.sendMessage(chatId, "შეიყვანეთ ფასი (მაგ: 129.99):");
                break;
            case "awaiting_price":
                state.price = text;
                state.step = "awaiting_sizes";
                adminBot.sendMessage(chatId, "შეიყვანეთ ზომები მძიმით გამოყოფილი (მაგ: S,M,L,XL):");
                break;
            case "awaiting_sizes":
                state.sizes = text.split(',').map(s => s.trim().toUpperCase());
                state.step = "awaiting_image";
                adminBot.sendMessage(chatId, "გამომიგზავნეთ პროდუქტის სურათის ლინკი (URL):");
                break;
            case "awaiting_image":
                const newProduct = {
                    id: Date.now(),
                    name: { ge: state.name, en: state.name },
                    price: state.price,
                    oldPrice: null,
                    category: 'new',
                    gender: 'women', // ესეც შეიძლება კითხვის სახით დაემატოს
                    imageUrls: [text],
                    sizes: state.sizes,
                    description: { ge: "აღწერა...", en: "Description..." }
                };
                products.push(newProduct);
                adminBot.sendMessage(chatId, `✅ პროდუქტი "${state.name}" წარმატებით დაემატა!`);
                delete userStates[chatId];
                break;
            case "awaiting_delete_id":
                const productIdToDelete = parseInt(text);
                const initialLength = products.length;
                products = products.filter(p => p.id !== productIdToDelete);
                if (products.length < initialLength) {
                    adminBot.sendMessage(chatId, `✅ პროდუქტი ID: ${productIdToDelete} წაიშალა.`);
                } else {
                    adminBot.sendMessage(chatId, `❌ პროდუქტი ID: ${productIdToDelete} ვერ მოიძებნა.`);
                }
                delete userStates[chatId];
                break;
        }
    }
});

// სერვერის გაშვება
app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});
