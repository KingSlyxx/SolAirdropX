// server.js (სრული, გასწორებული ვერსია)

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

// --- ფუნქცია, რომელიც ამოწმებს ბაზასთან კავშირს და ქმნის ცხრილებს ---
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

        console.log('Tables are successfully created or already exist.');
        client.release();
    } catch (err) {
        console.error('Failed to initialize database:', err);
        process.exit(1);
    }
};

// Express კონფიგურაცია
app.use(cors());
app.use(express.static('public'));
app.use(bodyParser.json());

// --- ჩატის სესიების მართვის ობიექტები ---
const liveChatSessions = {};
const activeChats = {};
const operatorSelection = {};
const userState = {};

// =================================================================
// 1. ადმინისტრატორის ბოტის ლოგიკა
// =================================================================
let adminBot;
if (ADMIN_BOT_TOKEN) {
    adminBot = new TelegramBot(ADMIN_BOT_TOKEN, { polling: true });
    console.log('Admin Bot is running...');

    const mainMenuKeyboard = {
        keyboard: [[{ text: 'პროდუქტების ნახვა' }], [{ text: 'პროდუქტის დამატება' }]],
        resize_keyboard: true,
    };

    const resetState = (chatId) => delete userState[chatId];
    
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

    adminBot.onText(/\/start/, (msg) => {
        resetState(msg.chat.id);
        adminBot.sendMessage(msg.chat.id, 'მოგესალმებით! აირჩიეთ მოქმედება:', { reply_markup: mainMenuKeyboard });
    });

    adminBot.onText(/პროდუქტების ნახვა/, async (msg) => {
        try {
            const result = await pool.query('SELECT * FROM products ORDER BY id ASC');
            const products = result.rows;
            if (products.length === 0) {
                return adminBot.sendMessage(msg.chat.id, "პროდუქტები არ არის დამატებული.");
            }
            await adminBot.sendMessage(msg.chat.id, "პროდუქტების სია:");
            for (const p of products) {
                const formattedProduct = formatProductFromDb(p);
                const caption = `ID: ${formattedProduct.id}\nსახელი: ${formattedProduct.name.ge}\nფასი: ₾${formattedProduct.price}${formattedProduct.oldPrice ? ` (ძველი: ₾${formattedProduct.oldPrice})` : ''}`;
                const inlineKeyboard = {
                    inline_keyboard: [[
                        { text: 'რედაქტირება', callback_data: `edit_${p.id}` },
                        { text: 'წაშლა', callback_data: `delete_${p.id}` }
                    ]]
                };
                if (formattedProduct.imageUrls && formattedProduct.imageUrls.length > 0) {
                    await adminBot.sendPhoto(msg.chat.id, formattedProduct.imageUrls[0], { caption, reply_markup: inlineKeyboard });
                } else {
                    await adminBot.sendMessage(msg.chat.id, caption, { reply_markup: inlineKeyboard });
                }
            }
        } catch (err) {
            console.error(err);
            adminBot.sendMessage(msg.chat.id, "პროდუქტების ჩატვირთვისას მოხდა შეცდომა.");
        }
    });

    adminBot.onText(/პროდუქტის დამატება/, (msg) => {
        userState[msg.chat.id] = { step: 'awaiting_name_ge', product: { imageUrls: [], qcImageUrls: [] } };
        adminBot.sendMessage(msg.chat.id, 'შეიყვანეთ პროდუქტის სახელი (ქართულად):', { reply_markup: { force_reply: true } });
    });

    adminBot.on('callback_query', async (cb) => {
        const msg = cb.message;
        const [action, ...params] = cb.data.split('_');
        const productId = parseInt(params[0]);

        try {
            switch (action) {
                case 'delete':
                    adminBot.sendMessage(msg.chat.id, `დარწმუნებული ხართ, რომ გსურთ პროდუქტის (ID: ${productId}) წაშლა?`, {
                        reply_markup: { inline_keyboard: [[{ text: 'კი', callback_data: `confirm-delete_${productId}` }, { text: 'არა', callback_data: 'cancel-delete' }]] }
                    });
                    break;
                case 'confirm-delete':
                    await pool.query('DELETE FROM products WHERE id = $1', [productId]);
                    adminBot.editMessageText(`პროდუქტი (ID: ${productId}) წარმატებით წაიშალა.`, { chat_id: msg.chat.id, message_id: msg.message_id });
                    break;
                case 'cancel-delete':
                    adminBot.editMessageText('წაშლა გაუქმდა.', { chat_id: msg.chat.id, message_id: msg.message_id });
                    break;
                case 'edit':
                    userState[msg.chat.id] = { step: 'editing_product', productId };
                    adminBot.sendMessage(msg.chat.id, `აირჩიეთ რისი რედაქტირება გსურთ (ID: ${productId})`, {
                        reply_markup: { inline_keyboard: [
                            [{ text: 'სახელი (GE)', callback_data: `edit-field_name_ge_${productId}` }],
                            [{ text: 'ფასი', callback_data: `edit-field_price_${productId}` }],
                            [{ text: 'პროდ. სურათები (გადაწერა)', callback_data: `edit-field_image_urls_${productId}` }],
                        ]}
                    });
                    break;
                 case 'edit-field':
                    const [field, prodId] = params;
                    userState[msg.chat.id] = { step: 'awaiting_edit_value', productId: parseInt(prodId), field: field };
                    adminBot.sendMessage(msg.chat.id, `შეიყვანეთ ახალი მნიშვნელობა ველისთვის "${field}":`, { reply_markup: { force_reply: true } });
                    break;
            }
        } catch(err) {
            console.error('Callback query error:', err);
        }
        adminBot.answerCallbackQuery(cb.id);
    });
    
    adminBot.on('photo', async (msg) => {
        const chatId = msg.chat.id;
        const state = userState[chatId];
        
        const validSteps = ['awaiting_images', 'awaiting_qc_images', 'awaiting_edit_images', 'awaiting_edit_qc_images'];
        if (!state || !validSteps.includes(state.step)) return;
        
        if (!IMGBB_API_KEY) {
            return adminBot.sendMessage(chatId, 'imgbb.com API გასაღები არ არის მითითებული სერვერზე.');
        }

        try {
            await adminBot.sendMessage(chatId, 'ფოტოს დამუშავება, გთხოვთ მოიცადოთ...');
            const fileId = msg.photo[msg.photo.length - 1].file_id;
            const fileLink = await adminBot.getFileLink(fileId);

            const imageResponse = await axios.get(fileLink, { responseType: 'arraybuffer' });
            
            const form = new FormData();
            form.append('image', imageResponse.data, { filename: 'telegram_photo.jpg' });

            const uploadResponse = await axios.post(`https://api.imgbb.com/1/upload?key=${IMGBB_API_KEY}`, form, {
                headers: form.getHeaders(),
            });

            if (uploadResponse.data.success) {
                const imageUrl = uploadResponse.data.data.url;
                if(state.step === 'awaiting_images') state.product.imageUrls.push(imageUrl);
                else if(state.step === 'awaiting_qc_images') state.product.qcImageUrls.push(imageUrl);
                else if(state.step === 'awaiting_edit_images') state.newImageUrls.push(imageUrl);
                else if(state.step === 'awaiting_edit_qc_images') state.newQcImageUrls.push(imageUrl);
                
                await adminBot.sendMessage(chatId, `ფოტო წარმატებით აიტვირთა. გამოაგზავნეთ შემდეგი ან დაწერეთ 'done'.`);
            } else {
                throw new Error(uploadResponse.data.error.message);
            }
        } catch (e) {
            console.error('Image upload failed:', e);
            await adminBot.sendMessage(chatId, `ფოტოს ატვირთვა ვერ მოხერხდა: ${e.message}`);
        }
    });

    adminBot.on('message', async (msg) => {
        const commandText = ['პროდუქტების ნახვა', 'პროდუქტის დამატება'];
        if (!msg.text || msg.text.startsWith('/') || commandText.includes(msg.text)) return;
        
        const state = userState[msg.chat.id];
        if (!state) return;

        try {
            switch (state.step) {
                 case 'awaiting_name_ge':
                    state.product.name_ge = msg.text;
                    state.step = 'awaiting_name_en';
                    adminBot.sendMessage(msg.chat.id, 'შეიყვანეთ პროდუქტის სახელი (ინგლისურად):', { reply_markup: { force_reply: true } });
                    break;
                case 'awaiting_name_en':
                    state.product.name_en = msg.text;
                    state.step = 'awaiting_price';
                    adminBot.sendMessage(msg.chat.id, 'შეიყვანეთ ფასი (მაგ: 129.99):', { reply_markup: { force_reply: true } });
                    break;
                case 'awaiting_price':
                    state.product.price = parseFloat(msg.text);
                    state.step = 'awaiting_old_price';
                    adminBot.sendMessage(msg.chat.id, 'შეიყვანეთ ძველი ფასი (თუ არ აქვს, დაწერეთ 0):', { reply_markup: { force_reply: true } });
                    break;
                case 'awaiting_old_price':
                    state.product.old_price = parseFloat(msg.text) > 0 ? parseFloat(msg.text) : null;
                    state.step = 'awaiting_description_ge';
                    adminBot.sendMessage(msg.chat.id, 'შეიყვანეთ პროდუქტის აღწერა (ქართულად):', { reply_markup: { force_reply: true } });
                    break;

                // --- [გასწორებული] დამატებულია გამოტოვებული ნაწილები ---
                case 'awaiting_description_ge':
                    state.product.description_ge = msg.text;
                    state.step = 'awaiting_description_en';
                    adminBot.sendMessage(msg.chat.id, 'შეიყვანეთ პროდუქტის აღწერა (ინგლისურად):', { reply_markup: { force_reply: true } });
                    break;
                case 'awaiting_description_en':
                    state.product.description_en = msg.text;
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
                    state.step = 'awaiting_sizes';
                    adminBot.sendMessage(msg.chat.id, 'შეიყვანეთ ზომები მძიმით გამოყოფით (მაგ: S,M,L):', { reply_markup: { force_reply: true } });
                    break;
                // --- გასწორების დასასრული ---

                case 'awaiting_sizes':
                    state.product.sizes = msg.text.split(',').map(s => s.trim().toUpperCase());
                    state.step = 'awaiting_images';
                    adminBot.sendMessage(msg.chat.id, "ატვირთეთ პროდუქტის ძირითადი ფოტო(ები). დასრულების შემდეგ, დაწერეთ 'done'.");
                    break;
                case 'awaiting_images':
                    if (msg.text.toLowerCase() === 'done') {
                        if (state.product.imageUrls.length === 0) return adminBot.sendMessage(msg.chat.id, "გთხოვთ, მინიმუმ ერთი ფოტო ატვირთოთ.");
                        state.step = 'awaiting_qc_images';
                        adminBot.sendMessage(msg.chat.id, "ახლა ატვირთეთ 'ხარისხის შემოწმების' ფოტო(ები). დასრულების შემდეგ, დაწერეთ 'done'.");
                    }
                    break;
                 case 'awaiting_qc_images':
                    if (msg.text.toLowerCase() === 'done') {
                        const p = state.product;
                        const query = `
                            INSERT INTO products (name_ge, name_en, price, old_price, description_ge, description_en, category, gender, sizes, image_urls, qc_image_urls)
                            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
                            RETURNING id;
                        `;
                        const values = [p.name_ge, p.name_en, p.price, p.old_price, p.description_ge, p.description_en, p.category, p.gender, p.sizes, p.imageUrls, p.qcImageUrls];
                        
                        const result = await pool.query(query, values);
                        const newId = result.rows[0].id;

                        adminBot.sendMessage(msg.chat.id, `პროდუქტი (ID: ${newId}) წარმატებით დაემატა.`, { reply_markup: mainMenuKeyboard });
                        resetState(msg.chat.id);
                    }
                    break;
                
                case 'awaiting_edit_value':
                    const { productId, field } = state;
                    const value = msg.text;
                    const updateQuery = `UPDATE products SET ${field} = $1 WHERE id = $2`;
                    await pool.query(updateQuery, [value, productId]);
                    
                    adminBot.sendMessage(msg.chat.id, `პროდუქტის ველი '${field}' განახლდა.`);
                    resetState(msg.chat.id);
                    break;
            }
        } catch (e) {
            adminBot.sendMessage(msg.chat.id, `დაფიქსირდა შეცდომა: ${e.message}\nსცადეთ თავიდან.`);
            resetState(msg.chat.id);
        }
    });
}

// =================================================================
// 2. ლაივ ჩატის ბოტის ლოგიკა
// =================================================================
// ... (თქვენი ლაივ ჩატის კოდი აქ უცვლელად)

// =================================================================
// 3. API მარშრუტები (Endpoints)
// =================================================================
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

app.post('/api/submit-order', async (req, res) => {
    try {
        const newOrder = req.body;
        const orderId = 'LXRY' + Date.now();
        
        const query = `
            INSERT INTO orders (order_id, customer_data, items, total_price)
            VALUES ($1, $2, $3, $4);
        `;
        const values = [orderId, newOrder.customer, newOrder.items, newOrder.totalPrice];
        await pool.query(query, values);

        if (TELEGRAM_CHANNEL_ID && adminBot) {
            let message = `ახალი შეკვეთა: #${orderId}\n...`; 
            adminBot.sendMessage(TELEGRAM_CHANNEL_ID, message);
        }
        res.status(201).json({ success: true, orderId });
    } catch (error) {
        console.error('Order submission error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

app.get('/api/order-status/:id', async (req, res) => {
    try {
        const result = await pool.query('SELECT status FROM orders WHERE order_id = $1', [req.params.id]);
        if (result.rows.length > 0) {
            res.json({ status: result.rows[0].status });
        } else {
            res.status(404).json({ message: 'Order not found' });
        }
    } catch (error) {
        res.status(500).json({ message: 'Server error' });
    }
});

// ... (სხვა API მარშრუტები აქ უცვლელად)


// --- სერვერის გაშვება ---
app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
  initializeDatabase();
});
