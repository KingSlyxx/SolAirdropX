// server.js (სრული, საბოლოო და გამართული ვერსია)

const express = require('express');
const bodyParser = require('body-parser');
const TelegramBot = require('node-telegram-bot-api');
const cors = require('cors');
const fs = require('fs').promises;
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

// --- გარემოს ცვლადები (Environment Variables) ---
const ADMIN_BOT_TOKEN = process.env.ADMIN_BOT_TOKEN;
const LIVE_CHAT_BOT_TOKEN = process.env.LIVE_CHAT_BOT_TOKEN;
const TELEGRAM_CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID;

// --- Express-ის კონფიგურაცია ---
app.use(cors());
app.use(express.static('public')); 
app.use(bodyParser.json());

const PRODUCTS_FILE_PATH = path.join(__dirname, 'products.json');
const liveChatSessions = {};
const userState = {}; // მომხმარებლის მდგომარეობის შესანახად

// --- ფაილთან მუშაობის ფუნქციები (გამოტანილია გლობალურ არეში) ---
const readProducts = async () => {
    try {
        await fs.access(PRODUCTS_FILE_PATH);
        const data = await fs.readFile(PRODUCTS_FILE_PATH, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        if (error.code === 'ENOENT') { // თუ ფაილი არ არსებობს, ვქმნით მას
            await fs.writeFile(PRODUCTS_FILE_PATH, '[]', 'utf8');
            return [];
        }
        console.error("Error reading products file:", error);
        throw error;
    }
};
const writeProducts = async (data) => await fs.writeFile(PRODUCTS_FILE_PATH, JSON.stringify(data, null, 2));

// =================================================================
// 1. ადმინისტრატორის ბოტის ლოგიკა (ღილაკებით)
// =================================================================
let adminBot;
if (ADMIN_BOT_TOKEN) {
    adminBot = new TelegramBot(ADMIN_BOT_TOKEN, { polling: true });
    console.log('Admin Bot is running...');

    const mainMenuKeyboard = {
        keyboard: [[{ text: '📦 პროდუქტების ნახვა' }], [{ text: '➕ პროდუქტის დამატება' }]],
        resize_keyboard: true,
    };

    adminBot.onText(/\/start/, (msg) => {
        delete userState[msg.chat.id];
        adminBot.sendMessage(msg.chat.id, 'მოგესალმებით! აირჩიეთ მოქმედება:', { reply_markup: mainMenuKeyboard });
    });

    adminBot.onText(/📦 პროდუქტების ნახვა/, async (msg) => {
        const products = await readProducts();
        if (products.length === 0) {
            adminBot.sendMessage(msg.chat.id, "პროდუქტები არ არის დამატებული.");
            return;
        }
        adminBot.sendMessage(msg.chat.id, "პროდუქტების სია:");
        for (const p of products) {
            const caption = `ID: ${p.id}\nსახელი: ${p.name.ge}\nფასი: ₾${p.price}`;
            const inlineKeyboard = {
                inline_keyboard: [[{ text: '🗑️ წაშლა', callback_data: `delete_${p.id}` }]]
            };
            if (p.imageUrls && p.imageUrls.length > 0) {
                try {
                    await adminBot.sendPhoto(msg.chat.id, p.imageUrls[0], { caption: caption, reply_markup: inlineKeyboard });
                } catch (e) {
                    await adminBot.sendMessage(msg.chat.id, `სურათის ჩატვირთვის შეცდომა (${p.imageUrls[0]}).\n${caption}`, { reply_markup: inlineKeyboard });
                }
            } else {
                await adminBot.sendMessage(msg.chat.id, caption, { reply_markup: inlineKeyboard });
            }
        }
    });

    adminBot.onText(/➕ პროდუქტის დამატება/, (msg) => {
        userState[msg.chat.id] = { step: 'awaiting_name_ge', product: {} };
        adminBot.sendMessage(msg.chat.id, 'შეიყვანეთ პროდუქტის სახელი (ქართულად):', { reply_markup: { force_reply: true } });
    });

    adminBot.on('callback_query', async (callbackQuery) => {
        const msg = callbackQuery.message;
        const data = callbackQuery.data;
        if (data.startsWith('delete_')) {
            const productId = data.split('_')[1];
            adminBot.sendMessage(msg.chat.id, `დარწმუნებული ხართ, რომ გსურთ პროდუქტის (ID: ${productId}) წაშლა?`, {
                reply_markup: {
                    inline_keyboard: [[{ text: 'კი', callback_data: `confirm_delete_${productId}` }, { text: 'არა', callback_data: 'cancel_delete' }]]
                }
            });
        } else if (data.startsWith('confirm_delete_')) {
            const productId = parseInt(data.split('_')[2]);
            const products = await readProducts();
            const updatedProducts = products.filter(p => p.id !== productId);
            await writeProducts(updatedProducts);
            adminBot.editMessageText(`✅ პროდუქტი (ID: ${productId}) წარმატებით წაიშალა.`, { chat_id: msg.chat.id, message_id: msg.message_id });
        } else if (data === 'cancel_delete') {
            adminBot.editMessageText('წაშლა გაუქმდა.', { chat_id: msg.chat.id, message_id: msg.message_id });
        }
        adminBot.answerCallbackQuery(callbackQuery.id);
    });

    adminBot.on('message', async (msg) => {
        if (msg.text && (msg.text.startsWith('/') || ['📦 პროდუქტების ნახვა', '➕ პროდუქტის დამატება'].includes(msg.text))) return;
        const state = userState[msg.chat.id];
        if (!state) return;

        try {
            switch (state.step) {
                case 'awaiting_name_ge':
                    state.product.name = { ge: msg.text };
                    state.step = 'awaiting_name_en';
                    adminBot.sendMessage(msg.chat.id, 'შეიყვანეთ პროდუქტის სახელი (ინგლისურად):', { reply_markup: { force_reply: true } });
                    break;
                case 'awaiting_name_en':
                    state.product.name.en = msg.text;
                    state.step = 'awaiting_price';
                    adminBot.sendMessage(msg.chat.id, 'შეიყვანეთ ფასი (მაგ: 129.99):', { reply_markup: { force_reply: true } });
                    break;
                case 'awaiting_price':
                    state.product.price = parseFloat(msg.text).toFixed(2);
                    state.step = 'awaiting_category';
                    adminBot.sendMessage(msg.chat.id, 'შეიყვანეთ კატეგორია (მაგ: dresses, shirts):', { reply_markup: { force_reply: true } });
                    break;
                case 'awaiting_category':
                    state.product.category = msg.text.toLowerCase();
                    state.step = 'awaiting_gender';
                    adminBot.sendMessage(msg.chat.id, 'მიუთითეთ სქესი (women ან men):', { reply_markup: { force_reply: true } });
                    break;
                case 'awaiting_gender':
                    state.product.gender = msg.text.toLowerCase();
                    state.step = 'awaiting_images';
                    adminBot.sendMessage(msg.chat.id, 'ატვირთეთ სურათის ლინკ(ებ)ი. მძიმით გამოყავით რამოდენიმე:', { reply_markup: { force_reply: true } });
                    break;
                case 'awaiting_images':
                    state.product.imageUrls = msg.text.split(',').map(url => url.trim());
                    const products = await readProducts();
                    const newId = products.length > 0 ? Math.max(...products.map(p => p.id)) + 1 : 1;
                    const newProduct = {
                        id: newId,
                        ...state.product,
                        sizes: ["XS", "S", "M", "L", "XL", "XXL"],
                        description: { ge: "", en: "" }
                    };
                    products.push(newProduct);
                    await writeProducts(products);
                    adminBot.sendMessage(msg.chat.id, `✅ პროდუქტი (ID: ${newId}) წარმატებით დაემატა.`, { reply_markup: mainMenuKeyboard });
                    delete userState[msg.chat.id];
                    break;
            }
        } catch (e) {
            adminBot.sendMessage(msg.chat.id, `❌ დაფიქსირდა შეცდომა: ${e.message}\n\nსცადეთ თავიდან.`);
            delete userState[msg.chat.id];
        }
    });
}

// =================================================================
// 2. ლაივ ჩატის ბოტის ლოგიკა
// =================================================================
let liveChatBot;
if (LIVE_CHAT_BOT_TOKEN) {
    liveChatBot = new TelegramBot(LIVE_CHAT_BOT_TOKEN, { polling: true });
    console.log('Live Chat Bot is running...');
    liveChatBot.on('message', (msg) => {
        if (msg.reply_to_message && msg.reply_to_message.text) {
            const originalText = msg.reply_to_message.text;
            const match = originalText.match(/\[ID: (chat_.*?)\]/);
            if (match && match[1]) {
                const sessionId = match[1];
                liveChatSessions[sessionId] = { operatorMessage: msg.text };
                liveChatBot.sendMessage(msg.chat.id, '✓ გაგზავნილია');
            }
        }
    });
}

// =================================================================
// 3. API მარშრუტები (Endpoints)
// =================================================================
app.get('/api/products', async (req, res) => {
    try {
        const products = await readProducts();
        res.json(products);
    } catch (err) {
        console.error("API Error fetching products:", err);
        res.status(500).json({ success: false, message: 'Could not fetch products' });
    }
});

app.post('/api/submit-order', (req, res) => {
    if (!adminBot || !TELEGRAM_CHANNEL_ID) return res.status(500).json({ success: false, message: 'Admin Bot not configured.' });
    const { customer, items, totalPrice } = req.body;
    const newOrderId = "LXRY" + Date.now().toString().slice(-6);
    const orderDetailsText = items.map(item => `- ${item.name.ge} (ზომა: ${item.size}) - ₾${item.price}`).join('\n');
    const customerInfoText = `\nსახელი: ${customer.firstName} ${customer.lastName}\nტელეფონი: ${customer.phone}\nმისამართი: ${customer.city}, ${customer.address}`;
    const notificationMessage = `🔔 **ახალი შეკვეთა!**\n\n**ID:** \`${newOrderId}\`\n\n**შეკვეთა:**\n${orderDetailsText}\n\n**სულ:** ₾${totalPrice}\n\n**მყიდველი:**${customerInfoText}`;
    adminBot.sendMessage(TELEGRAM_CHANNEL_ID, notificationMessage, { parse_mode: 'Markdown' });
    res.status(200).json({ success: true, orderId: newOrderId });
});

app.post('/api/live-chat', async (req, res) => {
    console.log('\n--- /api/live-chat endpoint hit ---');
    console.log(`Checking variables: LIVE_CHAT_BOT_TOKEN set: ${!!LIVE_CHAT_BOT_TOKEN}, TELEGRAM_CHANNEL_ID set: ${!!TELEGRAM_CHANNEL_ID}`);
    
    if (!liveChatBot || !TELEGRAM_CHANNEL_ID) {
        console.error('>>> CRITICAL: Live Chat not configured. Check environment variables.');
        return res.status(500).json({ success: false, message: 'Live Chat Bot not configured on server.' });
    }
    const { message, sessionId } = req.body;
    console.log('Received from website:', { sessionId });
    const notification = `${message}\n\n-------\n[ID: ${sessionId}]`;
    try {
        await liveChatBot.sendMessage(TELEGRAM_CHANNEL_ID, notification);
        console.log('>>> SUCCESS: Message sent to Telegram.');
        res.status(200).json({ success: true });
    } catch (error) {
        console.error('>>> CRITICAL: Failed to send message to Telegram.', error.message);
        res.status(500).json({ success: false, message: 'Server failed to send message to Telegram.' });
    }
});

app.get('/api/chat-response/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    if (liveChatSessions[sessionId]) {
        res.json({ success: true, message: liveChatSessions[sessionId].operatorMessage });
        delete liveChatSessions[sessionId];
    } else {
        res.json({ success: true, message: null });
    }
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`); 
});
