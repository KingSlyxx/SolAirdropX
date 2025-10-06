// server.js (სრული, განახლებული ვერსია)

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

// --- გარემოს ცვლადები ---
const ADMIN_BOT_TOKEN = process.env.ADMIN_BOT_TOKEN;
const LIVE_CHAT_BOT_TOKEN = process.env.LIVE_CHAT_BOT_TOKEN;
const TELEGRAM_CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID;
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
        // ... (ცხრილების შექმნის ლოგიკა უცვლელია)
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

let adminBot;
if (ADMIN_BOT_TOKEN) {
    adminBot = new TelegramBot(ADMIN_BOT_TOKEN, { polling: true });
    console.log('Admin Bot is running...');
    
    // --- თქვენი ტელეგრამ ბოტის სრული ლოგიკა პროდუქტების მართვისთვის (უცვლელია) ---
    // ... (აქ მოდის თქვენი ტელეგრამ ბოტის სრული ლოგიკა პროდუქტების მართვისთვის, რომელიც უცვლელი რჩება) ...
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

    adminBot.onText(/პროდუქტების ნახვა/, async (msg) => {
        const chatId = msg.chat.id;
        try {
            const result = await pool.query('SELECT * FROM products ORDER BY id ASC');
            if (result.rows.length === 0) return adminBot.sendMessage(chatId, "პროდუქტები არ არის დამატებული.");
            
            await adminBot.sendMessage(chatId, "პროდუქტების სია:");
            for (const p of result.rows) {
                const f = formatProductFromDb(p);
                const caption = `ID: ${f.id}\nსახელი: ${f.name.ge}\nფასი: ₾${f.price}${f.oldPrice ? ` (ძველი: ₾${f.oldPrice})` : ''}`;
                const inlineKeyboard = { inline_keyboard: [[{ text: 'რედაქტირება', callback_data: `edit_${p.id}` }, { text: 'წაშლა', callback_data: `delete_${p.id}` }]] };
                if (f.imageUrls && f.imageUrls.length > 0) {
                    await adminBot.sendPhoto(chatId, f.imageUrls[0], { caption, reply_markup: inlineKeyboard });
                } else {
                    await adminBot.sendMessage(chatId, caption, { reply_markup: inlineKeyboard });
                }
            }
        } catch (err) {
            console.error('Bot view products error:', err);
            adminBot.sendMessage(chatId, "პროდუქტების ჩატვირთვისას მოხდა შეცდომა.");
        }
    });
    
    adminBot.on('callback_query', async (callbackQuery) => {
        const msg = callbackQuery.message;
        const data = callbackQuery.data;
        const chatId = msg.chat.id;
        const [action, ...params] = data.split('_');
        try {
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
                await adminBot.editMessageCaption(caption, { chat_id: chatId, message_id: msg.message_id, reply_markup: editKeyboard });
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
                adminBot.sendMessage(chatId, "აირჩიეთ მოქმედება:", { reply_markup: mainMenuKeyboard });
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
        if (!msg.text || msg.text.startsWith('/')) return;
        const commandText = ['პროდუქტების ნახვა', 'პროდუქტის დამატება'];
        if (commandText.includes(msg.text) && !msg.reply_to_message) return;
        const state = userState[msg.chat.id];
        if (!state) return;
        const chatId = msg.chat.id;
        try {
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

// ===== [API ENDPOINTS] =====

app.get('/api/products', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM products ORDER BY id ASC');
        const products = result.rows.map(formatProductFromDb);
        res.json(products);
    } catch (err) {
        console.error('API /api/products error:', err);
        res.status(500).json({ success: false, message: 'Could not fetch products' });
    }
});

// [ახალი] ადმინ პანელის მონაცემების ენდფოინტი
app.get('/api/admin/sales-data', async (req, res) => {
    const months = parseInt(req.query.months, 10) || 3;
    if (isNaN(months) || months <= 0) {
        return res.status(400).json({ success: false, message: 'Invalid months parameter.' });
    }

    try {
        const query = `
            SELECT order_id, customer_data, items, total_price, created_at
            FROM orders
            WHERE created_at >= NOW() - INTERVAL '${months} months'
            ORDER BY created_at DESC;
        `;
        
        const { rows } = await pool.query(query);

        let totalRevenue = 0;
        rows.forEach(order => {
            totalRevenue += parseFloat(order.total_price);
        });

        const formattedSales = rows.map(order => ({
            orderId: order.order_id,
            customer: {
                firstName: order.customer_data.firstName,
                lastName: order.customer_data.lastName,
                phone: order.customer_data.phone
            },
            items: order.items.map(item => ({ name: { ge: item.name.ge } })),
            totalPrice: parseFloat(order.total_price),
            date: order.created_at
        }));

        res.json({
            success: true,
            totalRevenue: totalRevenue.toFixed(2),
            totalSales: rows.length,
            recentSales: formattedSales
        });

    } catch (err) {
        console.error('API /api/admin/sales-data error:', err);
        res.status(500).json({ success: false, message: 'Could not fetch admin sales data' });
    }
});

app.get('/api/orders', async (req, res) => {
    // ... (ეს ენდფოინტი უცვლელია, თუ გამოიყენება სხვაგან)
});

// [განახლებული] ვიზიტორის შეტყობინება დეტალური ლოგირებით
app.post('/api/visitor', async (req, res) => {
    console.log("Received request on /api/visitor"); 
    if (!adminBot || !TELEGRAM_CHANNEL_ID) {
        console.log("Visitor notification skipped: Bot or Channel ID not configured.");
        return res.status(200).json({ success: true, message: 'Visitor noted, but notifications are disabled.' });
    }
    const ip = req.ip;
    console.log(`Processing visitor with IP: ${ip}`);
    let message = `👤 *ახალი ვიზიტორი საიტზე*\n\n- *IP მისამართი:* \`${ip}\``;
    try {
        const geoResponse = await axios.get(`http://ip-api.com/json/${ip}`);
        console.log("Geolocation API response:", geoResponse.data);
        if (geoResponse.data && geoResponse.data.status === 'success') {
            const { country, countryCode, city, isp } = geoResponse.data;
            message += `\n- *ქვეყანა:* ${country} (${countryCode})`;
            message += `\n- *ქალაქი:* ${city}`;
            message += `\n- *პროვაიდერი:* ${isp}`;
        }
    } catch (e) {
        console.error(`Could not fetch geolocation for IP: ${ip}`, e.message);
        message += `\n- *ლოკაცია:* (Geo API შეცდომა)`;
    }
    
    console.log(`Attempting to send visitor notification to Telegram channel ${TELEGRAM_CHANNEL_ID}`);
    try {
        await adminBot.sendMessage(TELEGRAM_CHANNEL_ID, message, { parse_mode: 'Markdown' });
        console.log("Successfully sent visitor notification to Telegram.");
        res.status(200).json({ success: true, message: 'Notification sent' });
    } catch (e) {
        console.error("CRITICAL: Failed to send visitor notification to Telegram:", e.message);
        res.status(500).json({ success: false, message: 'Failed to send notification' });
    }
});

// [განახლებული] კალათაში დამატების შეტყობინება დეტალური ლოგირებით
app.post('/api/cart/add', async (req, res) => {
    console.log("Received request on /api/cart/add");
    console.log("Request body:", JSON.stringify(req.body, null, 2));

    if (!adminBot || !TELEGRAM_CHANNEL_ID) {
        console.log("Cart notification skipped: Bot or Channel ID not configured.");
        return res.status(200).json({ success: true, message: 'Cart action noted, but notifications are disabled.' });
    }

    const { product } = req.body; 
    if (!product || !product.name || !product.price) {
        console.error("Cart notification failed: Invalid product data received.");
        return res.status(400).json({ success: false, message: 'Product data is missing or invalid.' });
    }

    const ip = req.ip;
    console.log(`Processing 'add to cart' from IP: ${ip}`);

    let message = `🛒 *კალათაში დამატება*\n\n*პროდუქტი:*\n- დასახელება: *${product.name}*\n- ფასი: *₾${product.price}*\n`;

    try {
        const geoResponse = await axios.get(`http://ip-api.com/json/${ip}`);
        console.log("Geolocation API response for cart event:", geoResponse.data);
        if (geoResponse.data && geoResponse.data.status === 'success') {
            const { country, countryCode, city } = geoResponse.data;
            message += `\n*ვიზიტორის ინფორმაცია:*\n- IP: \`${ip}\`\n- ლოკაცია: ${city}, ${country} (${countryCode})`;
        }
    } catch (e) {
        message += `\n*ვიზიტორის ინფორმაცია:*\n- IP: \`${ip}\`\n- ლოკაცია: (Geo API შეცდომა)`;
        console.error(`Could not fetch geolocation for IP: ${ip}`, e.message);
    }

    console.log(`Attempting to send 'add to cart' notification to Telegram channel ${TELEGRAM_CHANNEL_ID}`);
    try {
        await adminBot.sendMessage(TELEGRAM_CHANNEL_ID, message, { parse_mode: 'Markdown' });
        console.log("Successfully sent 'add to cart' notification to Telegram.");
        res.status(200).json({ success: true, message: 'Cart notification sent' });
    } catch (e) {
        console.error("CRITICAL: Failed to send 'add to cart' notification to Telegram:", e.message);
        res.status(500).json({ success: false, message: 'Failed to send notification' });
    }
});


app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
  initializeDatabase();
});
