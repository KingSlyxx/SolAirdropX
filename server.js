// server.js (სრული ვერსია)

const express = require('express');
const bodyParser = require('body-parser');
const TelegramBot = require('node-telegram-bot-api');
const cors = require('cors');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');
const { Pool } = require('pg');

const app = express();
const port = process.env.PORT || 8080;

// --- გარემოს ცვლადები (განახლებულია თქვენი მონაცემებით) ---
const ADMIN_BOT_TOKEN = '8151755873:AAEBrslgbP49Q3FiTSKAm7fyQchNbUMVSe0'; // თქვენი Admin ბოტის ტოკენი
const TELEGRAM_CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID; // ეს არხი რჩება შეკვეთების და ვიზიტორების ნოტიფიკაციისთვის
const TELEGRAM_GROUP_ID = '-4644402426'; // [მნიშვნელოვანია] ეს არის ჯგუფის ID ლაივ ჩატისთვის
const IMGBB_API_KEY = process.env.IMGBB_API_KEY;
const DATABASE_URL = process.env.DATABASE_URL;

// --- PostgreSQL ბაზასთან კავშირის დამყარება ---
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
});

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
                order_id VARCHAR(20) PRIMARY KEY,
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

app.use(cors());
app.use(express.static('public'));
app.use(bodyParser.json());
app.set('trust proxy', true);

const userState = {};
const chatSessions = new Map(); // აქტიური ჩატების სესია

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

// ===== ADMIN BOT FOR PRODUCT MANAGEMENT & LIVE CHAT =====
let adminBot;
if (ADMIN_BOT_TOKEN) {
    adminBot = new TelegramBot(ADMIN_BOT_TOKEN, { polling: true });
    console.log('Admin Bot for product management and Live Chat is running...');
    
    const mainMenuKeyboard = { keyboard: [[{ text: 'პროდუქტების ნახვა' }], [{ text: 'პროდუქტის დამატება' }]], resize_keyboard: true };
    const resetState = (chatId) => delete userState[chatId];
    
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

    adminBot.onText(/\/start/, (msg) => {
        resetState(msg.chat.id);
        adminBot.sendMessage(msg.chat.id, 'მოგესალმებით! აირჩიეთ მოქმედება:', { reply_markup: mainMenuKeyboard });
    });

    // [განახლებულია] პროდუქტების ნახვის ბრძანება იწყებს კატეგორიის არჩევის პროცესს
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
            // [ახალი ლოგიკა] სქესის მიხედვით პროდუქტების სიის ჩვენება
            if (action === 'view' && params[0] === 'gender') {
                const gender = params[1]; // 'women', 'men', ან 'all'
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
                return; // ვასრულებთ აქ, რომ სხვა callback-ებმა არ იმუშაოს
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
                
                // ვამოწმებთ, მესიჯს აქვს თუ არა ფოტო, რომ გამოვიყენოთ სწორი მეთოდი (editMessageCaption vs editMessageText)
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
                // უკან დაბრუნებისას ვაჩვენებთ ისევ სქესის არჩევანს
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
    
    adminBot.on('message', async (msg) => {
        // Live Chat Reply Logic
        if (msg.reply_to_message && msg.reply_to_message.from.is_bot) {
            const originalMessage = msg.reply_to_message.text;
            if (originalMessage) {
                const sessionIdMatch = originalMessage.match(/\[Session ID: (\w+)\]/);
                if (sessionIdMatch && sessionIdMatch[1]) {
                    const sessionId = sessionIdMatch[1];
                    const session = chatSessions.get(sessionId);
                    if (session && msg.text) {
                        session.pendingMessages.push(msg.text);
                        chatSessions.set(sessionId, session);
                    }
                    return; 
                }
            }
        }

        if (!msg.text || msg.text.startsWith('/')) return;
        const commandText = ['პროდუქტების ნახვა', 'პროდუქტის დამატება'];
        if (commandText.includes(msg.text) && !msg.reply_to_message) return;
        
        const state = userState[msg.chat.id];
        if (!state) return; 
        
        const chatId = msg.chat.id;
        try {
            // [ახალი ლოგიკა] პროდუქტის ID-ის შეყვანის მოლოდინი
            if (state.step === 'awaiting_product_id_for_manage') {
                const productId = parseInt(msg.text, 10);
                if (isNaN(productId)) {
                    return adminBot.sendMessage(chatId, "არასწორი ფორმატი. გთხოვთ შეიყვანოთ მხოლოდ პროდუქტის ID (ციფრი).");
                }
                const result = await pool.query('SELECT * FROM products WHERE id = $1', [productId]);
                if (result.rows.length === 0) {
                    return adminBot.sendMessage(chatId, `პროდუქტი ID: ${productId} ვერ მოიძებნა.`);
                }
                const p = result.rows[0];
                const f = formatProductFromDb(p);
                const caption = `ID: ${f.id}\nსახელი: ${f.name.ge}\nფასი: ₾${f.price}${f.oldPrice ? ` (ძველი: ₾${f.oldPrice})` : ''}`;
                const inlineKeyboard = { inline_keyboard: [[{ text: 'რედაქტირება', callback_data: `edit_${p.id}` }, { text: 'წაშლა', callback_data: `delete_${p.id}` }]] };

                resetState(chatId); // ვასუფთავებთ მდგომარეობას

                if (f.imageUrls && f.imageUrls.length > 0) {
                    await adminBot.sendPhoto(chatId, f.imageUrls[0], { caption, reply_markup: inlineKeyboard });
                } else {
                    await adminBot.sendMessage(chatId, caption, { reply_markup: inlineKeyboard });
                }
                return; // ვასრულებთ, რომ დამატების ლოგიკაში არ გადავიდეს
            }

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
            if (state.step === 'awaiting_edit_images' && msg.text.toLowerCase() === 'done') {
                if (!state.newUrls || state.newUrls.length === 0) { return adminBot.sendMessage(chatId, "გთხოვთ, მინიმუმ ერთი ახალი ფოტო ატვირთოთ ან დაწერეთ 'cancel'."); }
                await pool.query(`UPDATE products SET ${state.field} = $1 WHERE id = $2`, [state.newUrls, state.productId]);
                adminBot.sendMessage(chatId, `✅ ფოტო(ები) წარმატებით განახლდა.`);
                resetState(chatId);
                return;
            }
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
                case 'awaiting_qc_images': if (msg.text.toLowerCase() === 'done') { const p = state.product; const query = `INSERT INTO products (name_ge, name_en, price, old_price, description_ge, description_en, category, gender, sizes, image_urls, qc_image_urls) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id;`; const values = [p.name_ge, p.name_en, p.price, p.old_price, p.description_ge, p.description_en, p.category, p.gender, p.sizes, p.imageUrls, p.qcImageUrls || []]; const result = await pool.query(query, values); adminBot.sendMessage(chatId, `პროდუქტი (ID: ${result.rows[0].id}) წარმატებით დაემატა.`, { reply_markup: mainMenuKeyboard }); resetState(chatId); } break;
            }
        } catch (e) { adminBot.sendMessage(chatId, `დაფიქსირდა შეცდომა: ${e.message}\nსცადეთ თავიდან.`); resetState(chatId); }
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

// API Endpoint-ი საიტიდან ახალი ჩატის დასაწყებად
app.post('/api/live-chat', (req, res) => {
    const { sessionId, isNewChat, userData, message } = req.body;
    if (!sessionId) {
        return res.status(400).json({ success: false, message: 'Session ID is required.' });
    }

    if (isNewChat) {
        // ახალი ჩატის დაწყება
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
        // მომხმარებლისგან მოსული ახალი მესიჯი
        const session = chatSessions.get(sessionId);
        if (session && adminBot && TELEGRAM_GROUP_ID) {
            const userMessage = `
💬 *მომხმარებლის შეტყობინება*
*${session.userData.name}:* ${message}
---
[Session ID: ${sessionId}]
            `;
            // პასუხის გასაცემად, გამოიყენეთ "Reply" ამ შეტყობინებაზე.
            adminBot.sendMessage(TELEGRAM_GROUP_ID, userMessage, { parse_mode: 'Markdown' })
                .catch(err => console.error("Failed to forward user message to group:", err.message));
        }
    }
    res.status(200).json({ success: true });
});

// API Endpoint-ი, რომელსაც საიტი პერიოდულად ამოწმებს ადმინის პასუხებისთვის
app.get('/api/chat-response/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    const session = chatSessions.get(sessionId);

    if (session && session.pendingMessages.length > 0) {
        // ვიღებთ პირველ პასუხს რიგიდან და ვუბრუნებთ საიტს
        const message = session.pendingMessages.shift();
        chatSessions.set(sessionId, session);
        res.json({ success: true, message });
    } else {
        res.json({ success: false, message: null });
    }
});

// ===== OTHER API ENDPOINTS =====

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

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
  initializeDatabase();
});
