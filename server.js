// server.js (სრული ვერსია, ჩატის გაუმჯობესებული მართვით)

const express = require('express');
const bodyParser = require('body-parser');
const TelegramBot = require('node-telegram-bot-api');
const cors = require('cors');
const fs = require('fs').promises;
const path = require('path');

const app = express();
const port = process.env.PORT || 8080;

// გარემოს ცვლადები (დარწმუნდით, რომ ესენი თქვენს ჰოსტინგზე მითითებულია)
const ADMIN_BOT_TOKEN = process.env.ADMIN_BOT_TOKEN;
const LIVE_CHAT_BOT_TOKEN = process.env.LIVE_CHAT_BOT_TOKEN;
const TELEGRAM_CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID;

// Express კონფიგურაცია
app.use(cors());
app.use(express.static('public'));
app.use(bodyParser.json());

const PRODUCTS_FILE_PATH = path.join(__dirname, 'products.json');

// --- ★ ახალი: ჩატის სესიების მართვის ობიექტები ★ ---
const liveChatSessions = {}; // ინახავს ოპერატორის პასუხებს ვებსაიტისთვის
const activeChats = {};      // ინახავს აქტიური ჩატების ინფორმაციას (სახელი, სესია, სტატუსი)
const operatorSelection = {}; // ინახავს, რომელ ჩატს ესაუბრება კონკრეტული ოპერატორი

// ფაილებთან მუშაობის ფუნქციები
const readProducts = async () => { /* ... (ეს ნაწილი უცვლელია) ... */ };
const writeProducts = async (data) => { /* ... (ეს ნაწილი უცვლელია) ... */ };

// =================================================================
// 1. ადმინისტრატორის ბოტის ლოგიკა (უცვლელია)
// =================================================================
if (ADMIN_BOT_TOKEN) {
    const adminBot = new TelegramBot(ADMIN_BOT_TOKEN, { polling: true });
    console.log('Admin Bot is running...');
    // ... (აქ თქვენი პროდუქტების მართვის სრული ლოგიკაა, რომელიც არ იცვლება) ...
}


// =================================================================
// 2. ლაივ ჩატის ბოტის განახლებული ლოგიკა
// =================================================================
let liveChatBot;
if (LIVE_CHAT_BOT_TOKEN) {
    liveChatBot = new TelegramBot(LIVE_CHAT_BOT_TOKEN, { polling: true });
    console.log('Live Chat Bot is running...');

    // --- ★ ახალი: ბრძანება აქტიური ჩატების სიის გამოსატანად ★ ---
    liveChatBot.onText(/\/chats/, async (msg) => {
        const chatId = msg.chat.id;
        const activeUserButtons = Object.values(activeChats)
            .filter(chat => chat.status === 'active')
            .map(chat => ([{
                text: `👤 ${chat.name} (${chat.sessionId.slice(-5)})`, // ვაჩენთ სესიის ბოლო 5 სიმბოლოს
                callback_data: `select_chat_${chat.sessionId}`
            }]));

        if (activeUserButtons.length === 0) {
            await liveChatBot.sendMessage(chatId, "ამჟამად აქტიური ჩატები არ არის.");
            return;
        }

        await liveChatBot.sendMessage(chatId, "აირჩიეთ მომხმარებელი, ვისაც გსურთ რომ მისწეროთ:", {
            reply_markup: {
                inline_keyboard: activeUserButtons
            }
        });
    });

    // --- ★ ახალი: ოპერატორის პასუხის დაჭერა და გადაგზავნა ★ ---
    liveChatBot.on('message', async (msg) => {
        // ვამოწმებთ, რომ შეტყობინება არ არის ბრძანება
        if (msg.text && msg.text.startsWith('/')) {
            return;
        }

        const operatorId = msg.from.id;

        // ვამოწმებთ, აქვს თუ არა ოპერატორს არჩეული აქტიური ჩატი
        const selectedSessionId = operatorSelection[operatorId];
        if (selectedSessionId && activeChats[selectedSessionId]) {
            const operatorMessage = msg.text;

            // ვინახავთ ოპერატორის შეტყობინებას, რომელსაც საიტი წამოიღებს
            liveChatSessions[selectedSessionId] = { operatorMessage };
            
            // ვპასუხობთ ოპერატორს, რომ შეტყობინება გაიგზავნა
            await liveChatBot.sendMessage(msg.chat.id, '✓ გაიგზავნა', { reply_to_message_id: msg.message_id });
        }
    });

    // --- ★ ახალი: ღილაკებზე რეაგირების ლოგიკა (Accept, Decline, Select) ★ ---
    liveChatBot.on('callback_query', async (callbackQuery) => {
        const msg = callbackQuery.message;
        const operator = callbackQuery.from;
        const data = callbackQuery.data;

        // 1. ახალი ჩატის დადასტურება
        if (data.startsWith('accept_chat_')) {
            const sessionId = data.replace('accept_chat_', '');
            if (activeChats[sessionId]) {
                activeChats[sessionId].status = 'active'; // ვცვლით სტატუსს
                
                // ვარედაქტირებთ საწყის შეტყობინებას, რომ პასუხი გაეცა
                await liveChatBot.editMessageText(
                    `✅ ${operator.first_name}-მა უპასუხა ჩატს:\n\n👤 სახელი: ${activeChats[sessionId].name}\n📧 მეილი: ${activeChats[sessionId].email}\n📦 შეკვეთა: ${activeChats[sessionId].orderId || 'არ არის'}`,
                    { chat_id: msg.chat.id, message_id: msg.message_id }
                );

                // ვინახავთ შეტყობინებას, რომ ოპერატორი შეუერთდა (გამოჩნდება საიტზე)
                liveChatSessions[sessionId] = { operatorMessage: 'ოპერატორი შემოგიერთდათ. რით შემიძლია დაგეხმაროთ?' };
            }
        }

        // 2. ახალი ჩატის უარყოფა
        if (data.startsWith('decline_chat_')) {
            const sessionId = data.replace('decline_chat_', '');
            if (activeChats[sessionId]) {
                await liveChatBot.editMessageText(
                    `❌ ჩატის მოთხოვნა უარყოფილია (${operator.first_name}).`,
                    { chat_id: msg.chat.id, message_id: msg.message_id }
                );
                // ვშლით ჩატს აქტიურების სიიდან
                delete activeChats[sessionId];
                 // შეგვიძლია მომხმარებელს საიტზე გავუგზავნოთ შეტყობინება, რომ ოპერატორი დაკავებულია
                liveChatSessions[sessionId] = { operatorMessage: 'ბოდიშს გიხდით, ამჟამად ყველა ოპერატორი დაკავებულია. გთხოვთ, სცადოთ მოგვიანებით.' };
            }
        }

        // 3. კონკრეტული ჩატის არჩევა
        if (data.startsWith('select_chat_')) {
            const sessionId = data.replace('select_chat_', '');
            if (activeChats[sessionId]) {
                operatorSelection[operator.id] = sessionId; // ვიმახსოვრებთ, რომ ეს ოპერატორი ამ ჩატს ესაუბრება
                
                await liveChatBot.sendMessage(operator.id, `➡️ თქვენ ახლა ესაუბრებით: ${activeChats[sessionId].name}. \nშეგიძლიათ პირდაპირ აქ დაწეროთ პასუხი.`);
                // ვხურავთ მენიუს
                await liveChatBot.deleteMessage(msg.chat.id, msg.message_id);
            }
        }

        liveChatBot.answerCallbackQuery(callbackQuery.id);
    });
}

// =================================================================
// 3. API მარშრუტები (Endpoints)
// =================================================================
app.get('/api/products', async (req, res) => { /* ... (უცვლელია) ... */ });
app.post('/api/submit-order', (req, res) => { /* ... (უცვლელია) ... */ });

// --- ★ განახლებული: /api/live-chat ენდფოინთი ★ ---
app.post('/api/live-chat', async (req, res) => {
    if (!LIVE_CHAT_BOT_TOKEN || !TELEGRAM_CHANNEL_ID) {
        return res.status(500).json({ success: false, message: 'Live Chat Bot not configured.' });
    }

    const { message, sessionId, isNewChat, userData } = req.body;
    
    // თუ ეს არის ახალი ჩატის დასაწყისი
    if (isNewChat && userData) {
        activeChats[sessionId] = {
            sessionId: sessionId,
            name: userData.name,
            email: userData.email,
            orderId: userData.orderId,
            status: 'pending' // საწყისი სტატუსი
        };

        const initialMessage = `🔔 **ახალი ჩატის მოთხოვნა**\n\n👤 **სახელი:** ${userData.name}\n📧 **მეილი:** ${userData.email}\n📦 **შეკვეთა:** ${userData.orderId || 'არ არის'}\n\n**შეტყობინება:**\n_"${message}"_`;
        
        try {
            await liveChatBot.sendMessage(TELEGRAM_CHANNEL_ID, initialMessage, {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: "✅ პასუხის გაცემა", callback_data: `accept_chat_${sessionId}` },
                            { text: "❌ უარყოფა", callback_data: `decline_chat_${sessionId}` }
                        ]
                    ]
                }
            });
            res.status(200).json({ success: true });
        } catch (error) {
            console.error('Error sending new chat request to Telegram:', error);
            res.status(500).json({ success: false, message: 'Failed to notify operator.' });
        }
    } 
    // თუ ეს არის უკვე არსებული ჩატის გაგრძელება
    else if (activeChats[sessionId] && activeChats[sessionId].status === 'active') {
        const ongoingMessage = `💬 **${activeChats[sessionId].name}:** ${message}`;
        try {
            await liveChatBot.sendMessage(TELEGRAM_CHANNEL_ID, ongoingMessage, { parse_mode: 'Markdown' });
            res.status(200).json({ success: true });
        } catch (error) {
             res.status(500).json({ success: false, message: 'Failed to send message.' });
        }
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


// ქვემოთ მოცემული ფუნქციები უცვლელია
async function readProducts() {
    try {
        await fs.access(PRODUCTS_FILE_PATH);
        const data = await fs.readFile(PRODUCTS_FILE_PATH, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        if (error.code === 'ENOENT') {
            await fs.writeFile(PRODUCTS_FILE_PATH, '[]', 'utf8');
            return [];
        }
        console.error("Error reading products file:", error);
        throw error;
    }
}
async function writeProducts(data) {
    await fs.writeFile(PRODUCTS_FILE_PATH, JSON.stringify(data, null, 2));
}

