// server.js (განახლებული ვერსია)

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

    const mainMenuKeyboard = { keyboard: [[{ text: 'პროდუქტების ნახვა' }], [{ text: 'პროდუქტის დამატება' }]], resize_keyboard: true };
    const resetState = (chatId) => delete userState[chatId];
    
    adminBot.onText(/\/start/, (msg) => {
        resetState(msg.chat.id);
        adminBot.sendMessage(msg.chat.id, 'მოგესალმებით! აირჩიეთ მოქმედება:', { reply_markup: mainMenuKeyboard });
    });

    adminBot.onText(/პროდუქტების ნახვა/, async (msg) => {
        try {
            const result = await pool.query('SELECT * FROM products ORDER BY id ASC');
            if (result.rows.length === 0) return adminBot.sendMessage(msg.chat.id, "პროდუქტები არ არის დამატებული.");
            
            await adminBot.sendMessage(msg.chat.id, "პროდუქტების სია:");
            for (const p of result.rows) {
                const f = formatProductFromDb(p);
                const caption = `ID: ${f.id}\nსახელი: ${f.name.ge}\nფასი: ₾${f.price}${f.oldPrice ? ` (ძველი: ₾${f.oldPrice})` : ''}`;
                const inlineKeyboard = { inline_keyboard: [[{ text: 'რედაქტირება', callback_data: `edit_${p.id}` }, { text: 'წაშლა', callback_data: `delete_${p.id}` }]] };
                if (f.imageUrls && f.imageUrls.length > 0) {
                    await adminBot.sendPhoto(msg.chat.id, f.imageUrls[0], { caption, reply_markup: inlineKeyboard });
                } else {
                    await adminBot.sendMessage(msg.chat.id, caption, { reply_markup: inlineKeyboard });
                }
            }
        } catch (err) {
            console.error('Bot view products error:', err);
            adminBot.sendMessage(msg.chat.id, "პროდუქტების ჩატვირთვისას მოხდა შეცდომა.");
        }
    });
    
    adminBot.on('callback_query', async (callbackQuery) => {
        const msg = callbackQuery.message;
        const data = callbackQuery.data;
        const chatId = msg.chat.id;
        const [action, ...params] = data.split('_');

        await adminBot.answerCallbackQuery(callbackQuery.id);

        if (action === 'delete') {
            const [productId] = params;
            try {
                await pool.query('DELETE FROM products WHERE id = $1', [productId]);
                await adminBot.deleteMessage(chatId, msg.message_id);
                adminBot.sendMessage(chatId, `✅ პროდუქტი ID:${productId} წარმატებით წაიშალა.`);
            } catch (err) {
                console.error('Error deleting product:', err);
                adminBot.sendMessage(chatId, 'წაშლისას მოხდა შეცდომა');
            }
        }

        if (action === 'edit') {
            const [productId] = params;
            userState[chatId] = { step: 'editing_product', productId: productId };
            const inlineKeyboard = {
                inline_keyboard: [
                    [{ text: 'ფოტოების რედაქტირება', callback_data: `editphotos_${productId}` }],
                    // მომავალში აქ დაემატება სხვა რედაქტირების ღილაკები
                    [{ text: 'უკან', callback_data: `cancel_edit` }]
                ]
            };
            adminBot.sendMessage(chatId, `აირჩიეთ რისი რედაქტირება გსურთ პროდუქტისთვის (ID: ${productId}):`, { reply_markup: inlineKeyboard });
        }

        if (action === 'editphotos') {
            const [productId] = params;
            const result = await pool.query('SELECT image_urls FROM products WHERE id = $1', [productId]);
            const imageUrls = result.rows[0]?.image_urls || [];
            if (imageUrls.length === 0) {
                 adminBot.sendMessage(chatId, "ამ პროდუქტს ფოტოები არ აქვს. შეგიძლიათ დაიწყოთ ახლის ატვირთვა.", {
                    reply_markup: {
                        inline_keyboard: [[{ text: 'ატვირთვის დასრულება', callback_data: `finish_photo_edit_${productId}` }]]
                    }
                });
                userState[chatId] = { step: 'awaiting_new_images', productId: productId };
                return;
            }

            await adminBot.sendMessage(chatId, "აირჩიეთ ფოტო წასაშლელად. როცა მორჩებით, დააჭირეთ 'დასრულება'.");
            for (let i = 0; i < imageUrls.length; i++) {
                const url = imageUrls[i];
                try {
                    await adminBot.sendPhoto(chatId, url, {
                        reply_markup: {
                            inline_keyboard: [[{ text: 'წაშლა 🗑️', callback_data: `deletephoto_${productId}_${i}` }]]
                        }
                    });
                } catch (e) {
                    console.error("Could not send photo for deletion:", url, e.message);
                }
            }
            await adminBot.sendMessage(chatId, "ფოტოების წაშლის შემდეგ, შეგიძლიათ ახლები გამომიგზავნოთ. პროცესის დასასრულებლად დააჭირეთ ღილაკს.", {
                reply_markup: {
                    inline_keyboard: [[{ text: 'ატვირთვის დასრულება', callback_data: `finish_photo_edit_${productId}` }]]
                }
            });
            userState[chatId] = { step: 'awaiting_new_images', productId: productId };
        }

        if (action === 'deletephoto') {
            const [productId, photoIndex] = params;
            try {
                const result = await pool.query('SELECT image_urls FROM products WHERE id = $1', [productId]);
                let imageUrls = result.rows[0]?.image_urls || [];
                if (imageUrls.length > photoIndex) {
                    imageUrls.splice(photoIndex, 1);
                    await pool.query('UPDATE products SET image_urls = $1 WHERE id = $2', [imageUrls, productId]);
                    await adminBot.deleteMessage(chatId, msg.message_id);
                    await adminBot.sendMessage(chatId, 'ფოტო წაიშალა.');
                }
            } catch (err) {
                 console.error('Error deleting photo:', err);
                 adminBot.sendMessage(chatId, 'ფოტოს წაშლისას მოხდა შეცდომა.');
            }
        }
        
        if (action === 'finish' && params[0] === 'photo' && params[1] === 'edit') {
            const [productId] = params.slice(2);
            adminBot.sendMessage(chatId, `პროდუქტის (ID: ${productId}) ფოტოების რედაქტირება დასრულებულია.`, { reply_markup: mainMenuKeyboard });
            resetState(chatId);
        }

        if (action === 'cancel' && params[0] === 'edit') {
            adminBot.sendMessage(chatId, `რედაქტირება გაუქმებულია.`, { reply_markup: mainMenuKeyboard });
            resetState(chatId);
        }
    });


    adminBot.onText(/პროდუქტის დამატება/, (msg) => {
        userState[msg.chat.id] = { step: 'awaiting_name_ge', product: {} };
        adminBot.sendMessage(msg.chat.id, 'შეიყვანეთ პროდუქტის სახელი (ქართულად):', { reply_markup: { force_reply: true } });
    });
    
    adminBot.on('message', async (msg) => {
        if (msg.reply_to_message || (userState[msg.chat.id] && msg.text && !msg.text.startsWith('/'))) {
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
                    case 'awaiting_sizes':
                        state.product.sizes = msg.text.split(',').map(s => s.trim().toUpperCase());
                        state.step = 'awaiting_images';
                        adminBot.sendMessage(msg.chat.id, "ატვირთეთ პროდუქტის ძირითადი ფოტო(ები). დასრულების შემდეგ, დაწერეთ 'done'.");
                        break;
                    case 'awaiting_images':
                        if (msg.text.toLowerCase() === 'done') {
                            if (!state.product.imageUrls || state.product.imageUrls.length === 0) return adminBot.sendMessage(msg.chat.id, "გთხოვთ, მინიმუმ ერთი ფოტო ატვირთოთ.");
                            state.step = 'awaiting_qc_images';
                            adminBot.sendMessage(msg.chat.id, "ახლა ატვირთეთ 'ხარისხის შემოწმების' ფოტო(ები). დასრულების შემდეგ, დაწერეთ 'done'.");
                        }
                        break;
                     case 'awaiting_qc_images':
                        if (msg.text.toLowerCase() === 'done') {
                            const p = state.product;
                            const query = `
                                INSERT INTO products (name_ge, name_en, price, old_price, description_ge, description_en, category, gender, sizes, image_urls, qc_image_urls)
                                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id;`;
                            const values = [p.name_ge, p.name_en, p.price, p.old_price, p.description_ge, p.description_en, p.category, p.gender, p.sizes, p.imageUrls, p.qcImageUrls || []];
                            const result = await pool.query(query, values);
                            adminBot.sendMessage(msg.chat.id, `პროდუქტი (ID: ${result.rows[0].id}) წარმატებით დაემატა.`, { reply_markup: mainMenuKeyboard });
                            resetState(msg.chat.id);
                        }
                        break;
                }
            } catch (e) {
                adminBot.sendMessage(msg.chat.id, `დაფიქსირდა შეცდომა: ${e.message}\nსცადეთ თავიდან.`);
                resetState(msg.chat.id);
            }
        }
    });

    adminBot.on('photo', async (msg) => {
        const chatId = msg.chat.id;
        const state = userState[chatId];
        if (!state || !['awaiting_images', 'awaiting_qc_images', 'awaiting_new_images'].includes(state.step)) return;
        if (!IMGBB_API_KEY) return adminBot.sendMessage(chatId, 'imgbb.com API გასაღები არ არის მითითებული სერვერზე.');
        try {
            const fileId = msg.photo[msg.photo.length - 1].file_id;
            const fileLink = await adminBot.getFileLink(fileId);
            const imageResponse = await axios.get(fileLink, { responseType: 'arraybuffer' });
            const form = new FormData();
            form.append('image', imageResponse.data, { filename: 'telegram_photo.jpg' });
            const uploadResponse = await axios.post(`https://api.imgbb.com/1/upload?key=${IMGBB_API_KEY}`, form, { headers: form.getHeaders() });
            
            if (!uploadResponse.data.success) {
                throw new Error(uploadResponse.data.error.message);
            }
            
            const imageUrl = uploadResponse.data.data.url;

            if (state.step === 'awaiting_new_images') {
                 const { productId } = state;
                 await pool.query('UPDATE products SET image_urls = array_append(image_urls, $1) WHERE id = $2', [imageUrl, productId]);
                 await adminBot.sendMessage(chatId, `ფოტო დაემატა პროდუქტს (ID: ${productId}). შეგიძლიათ გამოაგზავნოთ შემდეგი.`);
                 return;
            }

            const targetArray = state.step === 'awaiting_images' ? 'imageUrls' : 'qcImageUrls';
            if (!state.product[targetArray]) state.product[targetArray] = [];
            state.product[targetArray].push(imageUrl);
            adminBot.sendMessage(chatId, `ფოტო აიტვირთა. გამოაგზავნეთ შემდეგი ან დაწერეთ 'done'.`);

        } catch (e) {
            console.error('Image upload failed:', e);
            adminBot.sendMessage(chatId, `ფოტოს ატვირთვა ვერ მოხერხდა: ${e.message}`);
        }
    });
}

// --- სატესტო მონაცემების გენერატორი ადმინ პანელისთვის ---
const generateTestData = () => {
    const orders = [];
    const names = ["გიორგი", "ნინო", "დავითი", "ანა", "ლევანი", "მარიამი"];
    const surnames = ["ბერიძე", "კაპანაძე", "გელაშვილი", "მაისურაძე", "გიორგაძე"];
    const products = [
        { name: "LV SKATE SNEAKER", price: 900 }, { name: "DIOR B33 SPIN SNEAKER", price: 700 },
        { name: "GG BLACK SMALL BELT BAG", price: 270 }, { name: "LV DISCOVERY BACKPACK", price: 450 },
        { name: "LV ONTHEGO MM", price: 650 }, { name: "GG COTTON PIQUET POLO", price: 240 },
        { name: "DIOR OBLIQUE DOWN JACKET", price: 500 }
    ];

    const today = new Date();
    // 12 თვის განმავლობაში ვანაწილებთ 80-120 შეკვეთას
    const totalOrders = Math.floor(Math.random() * 41) + 80; 
    let totalRevenue = 0;

    for (let i = 0; i < totalOrders; i++) {
        const daysAgo = Math.floor(Math.random() * 365); // 0-დან 364 დღის წინ
        const orderDate = new Date(today);
        orderDate.setDate(today.getDate() - daysAgo);

        const numItems = Math.floor(Math.random() * 3) + 1;
        const orderItems = [];
        let orderTotal = 0;
        for (let j = 0; j < numItems; j++) {
            const product = products[Math.floor(Math.random() * products.length)];
            orderItems.push({ name: { ge: product.name, en: product.name } });
            orderTotal += product.price;
        }
        totalRevenue += orderTotal;

        orders.push({
            orderId: `TEST${1000 + i}`,
            items: orderItems,
            customer: {
                firstName: names[Math.floor(Math.random() * names.length)],
                lastName: surnames[Math.floor(Math.random() * surnames.length)],
                phone: `+9955${Math.floor(10000000 + Math.random() * 90000000)}`
            },
            totalPrice: orderTotal,
            date: orderDate.toISOString()
        });
    }
    
    // შემოსავლის კორექცია, რომ მოთხოვნილ დიაპაზონში ჩაჯდეს (20k-65k)
    const desiredTotal = Math.floor(Math.random() * (65000 - 20000 + 1)) + 20000;
    const correctionFactor = desiredTotal / totalRevenue;

    orders.forEach(order => {
        order.totalPrice = parseFloat((order.totalPrice * correctionFactor).toFixed(2));
    });

    return orders.sort((a, b) => new Date(b.date) - new Date(a.date));
};

const testSalesData = generateTestData();

// --- ადმინ პანელის API ---
app.get('/api/admin/sales-data', (req, res) => {
    const months = parseInt(req.query.months, 10) || 3;
    const cutoffDate = new Date();
    cutoffDate.setMonth(cutoffDate.getMonth() - months);

    const filteredSales = testSalesData.filter(sale => new Date(sale.date) >= cutoffDate);
    
    const totalRevenue = filteredSales.reduce((sum, sale) => sum + sale.totalPrice, 0);
    const totalSales = filteredSales.length;

    res.json({
        totalRevenue: totalRevenue.toFixed(2),
        totalSales: totalSales,
        recentSales: filteredSales.slice(0, 50) // ვაბრუნებთ მაქსიმუმ 50 ბოლო გაყიდვას
    });
});


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

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
  initializeDatabase();
});
