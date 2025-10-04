// server.js (სრული, საბოლოო და გამართული ვერსია)

const express = require('express');
const bodyParser = require('body-parser');
const TelegramBot = require('node-telegram-bot-api');
const cors = require('cors');
const fs = require('fs').promises;
const path = require('path');

const app = express();
const port = process.env.PORT || 8080;

// --- გარემოს ცვლადები (დარწმუნდით, რომ ესენი თქვენს ჰოსტინგზე მითითებულია) ---
const ADMIN_BOT_TOKEN = process.env.ADMIN_BOT_TOKEN;
const LIVE_CHAT_BOT_TOKEN = process.env.LIVE_CHAT_BOT_TOKEN;
const TELEGRAM_CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID;

// Express კონფიგურაცია
app.use(cors());
app.use(express.static('public')); 
app.use(bodyParser.json());

const PRODUCTS_FILE_PATH = path.join(__dirname, 'products.json');

// --- ჩატის სესიების მართვის ობიექტები ---
const liveChatSessions = {}; 
const activeChats = {};      
const operatorSelection = {}; 
const userState = {};

// --- ფაილთან მუშაობის ფუნქციები ---
const readProducts = async () => {
    try {
        await fs.access(PRODUCTS_FILE_PATH);
        const data = await fs.readFile(PRODUCTS_FILE_PATH, 'utf8');
        return data ? JSON.parse(data) : [];
    } catch (error) {
        if (error.code === 'ENOENT') {
            await fs.writeFile(PRODUCTS_FILE_PATH, '[]', 'utf8');
            return [];
        }
        console.error("Error reading products file:", error);
        throw error;
    }
};
const writeProducts = async (data) => {
    await fs.writeFile(PRODUCTS_FILE_PATH, JSON.stringify(data, null, 2));
};

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
        if (!products || products.length === 0) {
            return adminBot.sendMessage(msg.chat.id, "პროდუქტები არ არის დამატებული.");
        }
        await adminBot.sendMessage(msg.chat.id, "პროდუქტების სია:");
        for (const p of products) {
            const caption = `ID: ${p.id}\nსახელი: ${p.name.ge}\nფასი: ₾${p.price}`;
            const inlineKeyboard = { inline_keyboard: [[{ text: '🗑️ წაშლა', callback_data: `delete_${p.id}` }]] };
            if (p.imageUrls && p.imageUrls.length > 0) {
                try {
                    await adminBot.sendPhoto(msg.chat.id, p.imageUrls[0], { caption, reply_markup: inlineKeyboard });
                } catch (e) {
                    await adminBot.sendMessage(msg.chat.id, `სურათის ჩატვირთვის შეცდომა.\n${caption}`, { reply_markup: inlineKeyboard });
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
                reply_markup: { inline_keyboard: [[{ text: 'კი', callback_data: `confirm_delete_${productId}` }, { text: 'არა', callback_data: 'cancel_delete' }]] }
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
        if (!msg.text || msg.text.startsWith('/') || ['📦 პროდუქტების ნახვა', '➕ პროდუქტის დამატება'].includes(msg.text)) return;
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
                    const newProduct = { id: newId, name: state.product.name, price: state.product.price, category: state.product.category, gender: state.product.gender, imageUrls: state.product.imageUrls, sizes: ["XS", "S", "M", "L", "XL", "XXL"], description: { ge: "", en: "" } };
                    products.push(newProduct);
                    await writeProducts(products);
                    adminBot.sendMessage(msg.chat.id, `✅ პროდუქტი (ID: ${newId}) წარმატებით დაემატა.`, { reply_markup: mainMenuKeyboard });
                    delete userState[msg.chat.id];
                    break;
            }
        } catch (e) {
            adminBot.sendMessage(msg.chat.id, `❌ დაფიქსირდა შეცდომა: ${e.message}\nსცადეთ თავიდან.`);
            delete userState[msg.chat.id];
        }
    });
}

// =================================================================
// 2. ლაივ ჩატის ბოტის ლოგიკა (გაუმჯობესებული)
// =================================================================
let liveChatBot;
if (LIVE_CHAT_BOT_TOKEN) {
    liveChatBot = new TelegramBot(LIVE_CHAT_BOT_TOKEN, { polling: true });
    console.log('Live Chat Bot is running...');

    liveChatBot.onText(/\/chats/, async (msg) => {
        const chatId = msg.chat.id;
        const activeUserButtons = Object.values(activeChats).filter(chat => chat.status === 'active').map(chat => ([{ text: `👤 ${chat.name} (${chat.sessionId.slice(-5)})`, callback_data: `select_chat_${chat.sessionId}` }]));
        if (activeUserButtons.length === 0) return await liveChatBot.sendMessage(chatId, "ამჟამად აქტიური ჩატები არ არის.");
        await liveChatBot.sendMessage(chatId, "აირჩიეთ მომხმარებელი, ვისაც გსურთ რომ მისწეროთ:", { reply_markup: { inline_keyboard: activeUserButtons } });
    });

    liveChatBot.on('message', async (msg) => {
        if (msg.text && msg.text.startsWith('/')) return;
        const operatorId = msg.from.id;
        const selectedSessionId = operatorSelection[operatorId];
        if (selectedSessionId && activeChats[selectedSessionId]) {
            liveChatSessions[selectedSessionId] = { operatorMessage: msg.text };
            await liveChatBot.sendMessage(msg.chat.id, '✓ გაიგზავნა', { reply_to_message_id: msg.message_id });
        }
    });

    liveChatBot.on('callback_query', async (callbackQuery) => {
        const msg = callbackQuery.message;
        const operator = callbackQuery.from;
        const data = callbackQuery.data;

        if (data.startsWith('accept_chat_')) {
            const sessionId = data.replace('accept_chat_', '');
            if (activeChats[sessionId]) {
                activeChats[sessionId].status = 'active';
                await liveChatBot.editMessageText(`✅ ${operator.first_name}-მა უპასუხა ჩატს:\n\n👤 სახელი: ${activeChats[sessionId].name}`, { chat_id: msg.chat.id, message_id: msg.message_id });
                liveChatSessions[sessionId] = { operatorMessage: 'ოპერატორი შემოგიერთდათ. რით შემიძლია დაგეხმაროთ?' };
            }
        } else if (data.startsWith('decline_chat_')) {
            const sessionId = data.replace('decline_chat_', '');
            if (activeChats[sessionId]) {
                await liveChatBot.editMessageText(`❌ ჩატის მოთხოვნა უარყოფილია (${operator.first_name}).`, { chat_id: msg.chat.id, message_id: msg.message_id });
                delete activeChats[sessionId];
                liveChatSessions[sessionId] = { operatorMessage: 'ბოდიშს გიხდით, ამჟამად ყველა ოპერატორი დაკავებულია.' };
            }
        } else if (data.startsWith('select_chat_')) {
            const sessionId = data.replace('select_chat_', '');
            if (activeChats[sessionId]) {
                operatorSelection[operator.id] = sessionId;
                await liveChatBot.sendMessage(operator.id, `➡️ თქვენ ახლა ესაუბრებით: ${activeChats[sessionId].name}. შეგიძლიათ პირდაპირ აქ დაწეროთ პასუხი.`);
                await liveChatBot.deleteMessage(msg.chat.id, msg.message_id);
            }
        }
        liveChatBot.answerCallbackQuery(callbackQuery.id);
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
    if (!liveChatBot || !TELEGRAM_CHANNEL_ID) return res.status(500).json({ success: false, message: 'Live Chat Bot not configured.' });
    
    const { message, sessionId, isNewChat, userData } = req.body;
    
    if (isNewChat && userData) {
        activeChats[sessionId] = { sessionId, name: userData.name, email: userData.email, orderId: userData.orderId, status: 'pending' };
        const initialMessage = `🔔 **ახალი ჩატის მოთხოვნა**\n\n👤 **სახელი:** ${userData.name}\n📧 **მეილი:** ${userData.email}\n📦 **შეკვეთა:** ${userData.orderId || 'არ არის'}\n\n**შეტყობინება:**\n_"${message}"_`;
        try {
            await liveChatBot.sendMessage(TELEGRAM_CHANNEL_ID, initialMessage, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: "✅ პასუხის გაცემა", callback_data: `accept_chat_${sessionId}` }, { text: "❌ უარყოფა", callback_data: `decline_chat_${sessionId}` }]] } });
            res.status(200).json({ success: true });
        } catch (error) { res.status(500).json({ success: false, message: 'Failed to notify operator.' }); }
    } else if (activeChats[sessionId] && activeChats[sessionId].status === 'active') {
        const ongoingMessage = `💬 **${activeChats[sessionId].name}:** ${message}`;
        try {
            await liveChatBot.sendMessage(TELEGRAM_CHANNEL_ID, ongoingMessage, { parse_mode: 'Markdown' });
            res.status(200).json({ success: true });
        } catch (error) { res.status(500).json({ success: false, message: 'Failed to send message.' }); }
    } else {
        res.status(400).json({ success: false, message: 'Chat session not active or invalid.' });
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
